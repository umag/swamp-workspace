/**
 * METHODS suite for @magistr/herdr.
 *
 * Exercises every method's success and failure path with the subprocess
 * stubbed. Each test parses its arguments through the model's OWN
 * `arguments` schema before calling the implementation, so a defaulting or
 * validation mistake in the declared schema fails here too — testing the impl
 * alone would let a wrong schema through.
 *
 * The context double validates every write against the declared resource
 * schema, so "the method wrote the right shape" is asserted implicitly on
 * every call.
 */

import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import { z } from "npm:zod@4";
import { HerdrError } from "./lib/cli.ts";
import {
  model,
  runAgentManifests,
  runClose,
  runCreateTab,
  runCreateWorkspace,
  runCreateWorktree,
  runNotify,
  runPrompt,
  runRead,
  runReloadAgentManifests,
  runRunCommand,
  runSendKeys,
  runSendText,
  runServerLiveHandoff,
  runServerReloadConfig,
  runServerStop,
  runSessionDelete,
  runSessionStop,
  runSnapshot,
  runSplitPane,
  runStartAgent,
  runStatus,
  runUpdateAgentManifests,
  runWaitAgent,
  runWaitOutput,
} from "./herdr.ts";
import {
  argvLines,
  errorEnvelope,
  fakeContext,
  fakeEnv,
  fixtureStdout,
  onlyWrite,
  statusFixture,
  tableRunner,
} from "./lib/test_support.ts";

/** Parse raw arguments through the method's declared schema. */
function args<T>(method: string, raw: Record<string, unknown> = {}): T {
  const methods = model.methods as Record<string, { arguments: z.ZodTypeAny }>;
  return methods[method].arguments.parse(raw) as T;
}

// --- status ------------------------------------------------------------------

Deno.test("status: writes health, sessions and config validity", async () => {
  const { ctx, written } = fakeContext(model);
  const { run, calls } = tableRunner({
    "status": await statusFixture(),
    "session list --json": await fixtureStdout("session_list"),
    "config check": "config: ok\n",
  });

  await runStatus(run, args("status"), ctx);

  assertEquals(argvLines(calls), [
    "status",
    "session list --json",
    "config check",
  ]);
  const status = onlyWrite(written, "status").data;
  assertEquals(status.serverRunning, true);
  assertEquals((status.sessions as unknown[]).length, 1);
  assertEquals(status.configOk, true);
  assertEquals(status.configDetail, "config: ok");
  assertEquals(status.target, "local");
  assertEquals(status.remote, false);
});

Deno.test("status: an invalid config is reported without failing the check", async () => {
  const { ctx, written } = fakeContext(model);
  const { run } = tableRunner({
    "status": await statusFixture(),
    "session list --json": await fixtureStdout("session_list"),
    "config check": {
      code: 1,
      stdout: "",
      stderr: "config: invalid keybinding on line 12\n",
    },
  });

  await runStatus(run, args("status"), ctx);

  const status = onlyWrite(written, "status").data;
  assertEquals(status.configOk, false);
  assert(
    String(status.configDetail).includes("invalid keybinding"),
    String(status.configDetail),
  );
  assert(
    (status.notes as string[]).some((n) => n.includes("config check failed")),
    JSON.stringify(status.notes),
  );
});

Deno.test("status: an ssh instance reports the remote target it talked to", async () => {
  const { ctx, written } = fakeContext(model, {
    sshHost: "build.example",
    sshUser: "dev",
    sshPort: 2222,
  });
  const { run, calls } = tableRunner({
    "-o BatchMode=yes": await statusFixture(),
  });

  await runStatus(run, args("status"), ctx);

  // Every call went out through ssh, never the local herdr binary.
  assertEquals(calls.every((c) => c.cmd === "ssh"), true);
  const status = onlyWrite(written, "status").data;
  assertEquals(status.remote, true);
  assertEquals(status.target, "dev@build.example:2222");
});

Deno.test("status: a stopped server is reported, not thrown", async () => {
  const { ctx, written } = fakeContext(model);
  const { run } = tableRunner({
    "status": "client:\n  version: 0.8.0\n\nserver:\n  status: not running\n",
    "session list --json": '{"sessions":[]}',
  });

  await runStatus(run, args("status"), ctx);

  const status = onlyWrite(written, "status").data;
  assertEquals(status.serverRunning, false);
  assertEquals(status.serverStatus, "not running");
  assertEquals(status.compatible, false);
});

Deno.test("status: an unreadable session list degrades to a note", async () => {
  const { ctx, written } = fakeContext(model);
  const { run } = tableRunner({
    "status": await statusFixture(),
    "session list --json": errorEnvelope("socket_error", "connection refused"),
  });

  await runStatus(run, args("status"), ctx);

  const status = onlyWrite(written, "status").data;
  assertEquals(status.serverRunning, true);
  assertEquals(status.sessions, []);
  assert(
    String((status.notes as string[])[0]).includes("connection refused"),
    JSON.stringify(status.notes),
  );
});

Deno.test("status: a herdr binary that is missing fails the method", async () => {
  const { ctx } = fakeContext(model);
  const { run } = tableRunner({
    "status": () => {
      throw new Deno.errors.NotFound("No such file or directory (os error 2)");
    },
  });

  await assertRejects(
    () => runStatus(run, args("status"), ctx),
    Deno.errors.NotFound,
  );
});

// --- snapshot ----------------------------------------------------------------

Deno.test("snapshot: filters by workspace label and by agent state", async () => {
  const { ctx, written } = fakeContext(model);
  const { run } = tableRunner({
    "api snapshot": await fixtureStdout("api_snapshot"),
  });

  await runSnapshot(
    run,
    args("snapshot", { workspace: "project", status: ["working"] }),
    ctx,
  );

  const fleet = onlyWrite(written, "fleet").data;
  assertEquals(fleet.workspaceCount, 1);
  assertEquals(fleet.tabCount, 2);
  assertEquals(fleet.paneCount, 3);
  assertEquals(fleet.agentCount, 1);
  assertEquals(fleet.byStatus, { working: 1 });
  assertEquals(written.filter((w) => w.spec === "agent").length, 1);
});

Deno.test("snapshot: writeAgents false writes only the roll-up", async () => {
  const { ctx, written } = fakeContext(model);
  const { run } = tableRunner({
    "api snapshot": await fixtureStdout("api_snapshot"),
  });

  await runSnapshot(
    run,
    args("snapshot", { writeAgents: false }),
    ctx,
  );

  assertEquals(written.map((w) => w.spec), ["fleet"]);
  assertEquals(
    (onlyWrite(written, "fleet").data.agents as unknown[]).length,
    3,
  );
});

Deno.test("snapshot: an unknown workspace filter names the available ones", async () => {
  const { ctx } = fakeContext(model);
  const { run } = tableRunner({
    "api snapshot": await fixtureStdout("api_snapshot"),
  });

  const err = await assertRejects(
    () => runSnapshot(run, args("snapshot", { workspace: "nope" }), ctx),
    HerdrError,
  );
  assertEquals(err.code, "workspace_not_found");
  assert(err.message.includes("w1 (project)"), err.message);
});

// --- read --------------------------------------------------------------------

Deno.test("read: resolves the pane, captures text, and tags it with ids", async () => {
  const { ctx, written } = fakeContext(model);
  const { run, calls } = tableRunner({
    "pane get w1:p5": await fixtureStdout("pane_info"),
    "pane read w1:p5": "line one\nline two\n",
  });

  await runRead(
    run,
    args("read", { target: "w1:p5", lines: 40 }),
    ctx,
  );

  assertEquals(
    argvLines(calls)[1],
    "pane read w1:p5 --source visible --lines 40 --format text",
  );
  const out = onlyWrite(written, "output").data;
  assertEquals(out.paneId, "w1:p5");
  assertEquals(out.tabId, "w1:t5");
  assertEquals(out.workspaceId, "w1");
  assertEquals(out.agent, "claude");
  assertEquals(out.text, "line one\nline two\n");
  assertEquals(out.truncated, false);
});

Deno.test("read: via=agent uses the agent subcommand and allows detection", async () => {
  const { ctx, written } = fakeContext(model);
  const { run, calls } = tableRunner({
    "agent get docs-bot": await fixtureStdout("agent_info"),
    "agent read docs-bot": "detected screen\n",
  });

  await runRead(
    run,
    args("read", { target: "docs-bot", via: "agent", source: "detection" }),
    ctx,
  );

  assertEquals(argvLines(calls), [
    "agent get docs-bot",
    "agent read docs-bot --source detection --format text",
  ]);
  assertEquals(onlyWrite(written, "output").data.via, "agent");
});

Deno.test("read: detection is refused for a pane target before any call", async () => {
  const { ctx } = fakeContext(model);
  const { run, calls } = tableRunner({});

  const err = await assertRejects(
    () =>
      runRead(
        run,
        args("read", { target: "w1:p5", source: "detection" }),
        ctx,
      ),
    HerdrError,
  );
  assertEquals(err.code, "invalid_argument");
  assertEquals(calls.length, 0);
});

Deno.test("read: a capture over maxOutputBytes is truncated and flagged", async () => {
  const { ctx, written } = fakeContext(model, { maxOutputBytes: 1024 });
  const { run } = tableRunner({
    "pane get w1:p5": await fixtureStdout("pane_info"),
    "pane read w1:p5": "x".repeat(5000),
  });

  await runRead(run, args("read", { target: "w1:p5" }), ctx);

  const out = onlyWrite(written, "output").data;
  assertEquals(out.truncated, true);
  assertEquals(out.bytes, 5000);
  assertEquals(String(out.text).length, 1024);
});

// --- prompt ------------------------------------------------------------------

Deno.test("prompt: fans out over targets and records each outcome", async () => {
  const { ctx, written } = fakeContext(model);
  const { run, calls } = tableRunner({
    "agent list": await fixtureStdout("agent_list"),
    "agent prompt": await fixtureStdout("agent_prompted"),
  });

  await runPrompt(
    run,
    args("prompt", { targets: ["w1:p5", "docs-bot"], text: "status?" }),
    ctx,
  );

  assertEquals(argvLines(calls), [
    "agent list",
    "agent prompt w1:p5 status?",
    "agent prompt docs-bot status?",
  ]);
  const action = onlyWrite(written, "action").data;
  assertEquals(action.method, "prompt");
  assertEquals(action.targetCount, 2);
  assertEquals(action.okCount, 2);
  assertEquals(action.changed, true);
});

Deno.test("prompt: --wait and --until are forwarded with a raised timeout", async () => {
  const { ctx } = fakeContext(model);
  const { run, calls } = tableRunner({
    "agent list": await fixtureStdout("agent_list"),
    "agent prompt": await fixtureStdout("agent_prompted"),
  });

  await runPrompt(
    run,
    args("prompt", {
      targets: ["w1:p5"],
      text: "go",
      until: ["idle", "blocked"],
      timeoutMs: 120_000,
    }),
    ctx,
  );

  assertEquals(
    argvLines(calls)[1],
    "agent prompt w1:p5 go --wait --until idle --until blocked --timeout 120000",
  );
  // The subprocess cap must exceed herdr's own wait, or the transport would
  // kill a wait that herdr was still legitimately serving.
  assertEquals(calls[1].opts?.timeoutMs, 125_000);
});

Deno.test("prompt: the calling pane is skipped, not prompted", async () => {
  const { ctx, written } = fakeContext(model);
  const { run, calls } = tableRunner({
    "agent list": await fixtureStdout("agent_list"),
    "agent prompt": await fixtureStdout("agent_prompted"),
  });

  await runPrompt(
    run,
    args("prompt", { targets: ["w1:p5", "w1:p6"], text: "go" }),
    ctx,
    fakeEnv({ HERDR_PANE_ID: "w1:p5" }),
  );

  assertEquals(argvLines(calls), ["agent list", "agent prompt w1:p6 go"]);
  const results = onlyWrite(written, "action").data.results as Record<
    string,
    unknown
  >[];
  assertEquals(results[0].ok, true);
  assertEquals(results[0].changed, false);
  assert(
    String(results[0].detail).includes("skipped"),
    String(results[0].detail),
  );
});

Deno.test("prompt: includeSelf overrides the self-skip", async () => {
  const { ctx } = fakeContext(model);
  const { run, calls } = tableRunner({
    "agent list": await fixtureStdout("agent_list"),
    "agent prompt": await fixtureStdout("agent_prompted"),
  });

  await runPrompt(
    run,
    args("prompt", { targets: ["w1:p5"], text: "go", includeSelf: true }),
    ctx,
    fakeEnv({ HERDR_PANE_ID: "w1:p5" }),
  );

  assertEquals(argvLines(calls)[1], "agent prompt w1:p5 go");
});

Deno.test("prompt: one failing target is isolated, the rest still run", async () => {
  const { ctx, written } = fakeContext(model);
  const { run } = tableRunner({
    "agent list": await fixtureStdout("agent_list"),
    "agent prompt w1:p5": errorEnvelope(
      "agent_busy",
      "agent is not accepting input",
    ),
    "agent prompt w1:p6": await fixtureStdout("agent_prompted"),
  });

  await runPrompt(
    run,
    args("prompt", { targets: ["w1:p5", "w1:p6"], text: "go" }),
    ctx,
  );

  const action = onlyWrite(written, "action").data;
  assertEquals(action.okCount, 1);
  assertEquals(action.failedCount, 1);
  const results = action.results as Record<string, unknown>[];
  assert(
    String(results[0].detail).includes("agent_busy"),
    String(results[0].detail),
  );
});

Deno.test("prompt: failFast aborts on the first failure without writing", async () => {
  const { ctx, written } = fakeContext(model);
  const { run } = tableRunner({
    "agent list": await fixtureStdout("agent_list"),
    "agent prompt": errorEnvelope("agent_busy", "busy"),
  });

  await assertRejects(
    () =>
      runPrompt(
        run,
        args("prompt", {
          targets: ["w1:p5", "w1:p6"],
          text: "go",
          failFast: true,
        }),
        ctx,
      ),
    HerdrError,
  );
  assertEquals(written.length, 0);
});

Deno.test("prompt: when every target fails the method throws and writes nothing", async () => {
  const { ctx, written } = fakeContext(model);
  const { run } = tableRunner({
    "agent list": await fixtureStdout("agent_list"),
    "agent prompt": errorEnvelope("agent_busy", "busy"),
  });

  const err = await assertRejects(
    () =>
      runPrompt(
        run,
        args("prompt", { targets: ["w1:p5", "w1:p6"], text: "go" }),
        ctx,
      ),
    HerdrError,
  );
  assertEquals(err.code, "all_targets_failed");
  assertEquals(written.length, 0);
});

// --- wait-agent --------------------------------------------------------------

Deno.test("wait-agent: waits for the default idle state and records no change", async () => {
  const { ctx, written } = fakeContext(model);
  const { run, calls } = tableRunner({
    "agent wait": await fixtureStdout("agent_info"),
  });

  await runWaitAgent(
    run,
    args("wait-agent", { targets: ["w1:p5"] }),
    ctx,
  );

  assertEquals(argvLines(calls), ["agent wait w1:p5 --until idle"]);
  const action = onlyWrite(written, "action").data;
  assertEquals(action.changed, false);
  assertEquals(action.okCount, 1);
  const results = action.results as Record<string, unknown>[];
  assertEquals(results[0].status, "idle");
});

Deno.test("wait-agent: a herdr timeout surfaces as a failed target", async () => {
  const { ctx, written } = fakeContext(model);
  const { run } = tableRunner({
    "agent wait w1:p5": errorEnvelope("timeout", "timed out waiting for idle"),
    "agent wait w1:p6": await fixtureStdout("agent_info"),
  });

  await runWaitAgent(
    run,
    args("wait-agent", { targets: ["w1:p5", "w1:p6"], timeoutMs: 5000 }),
    ctx,
  );

  const action = onlyWrite(written, "action").data;
  assertEquals(action.failedCount, 1);
  assertEquals(action.okCount, 1);
});

// --- start-agent -------------------------------------------------------------

Deno.test("start-agent: starts in an empty pane and writes the agent", async () => {
  const { ctx, written } = fakeContext(model);
  const { run, calls } = tableRunner({
    "agent list": await fixtureStdout("agent_list"),
    "agent start": await fixtureStdout("agent_started"),
  });

  await runStartAgent(
    run,
    args("start-agent", { pane: "w1:p7", kind: "claude", name: "helper" }),
    ctx,
  );

  assertEquals(argvLines(calls), [
    "agent list",
    "agent start helper --kind claude --pane w1:p7",
  ]);
  const agent = onlyWrite(written, "agent");
  assertEquals(agent.instance, "agent-w1-p7");
  assertEquals(agent.data.name, "helper");
});

Deno.test("start-agent: a pane that already hosts an agent is left alone", async () => {
  const { ctx, written } = fakeContext(model);
  const { run, calls } = tableRunner({
    "agent list": await fixtureStdout("agent_list"),
  });

  await runStartAgent(
    run,
    args("start-agent", { pane: "w1:p5", kind: "claude", name: "helper" }),
    ctx,
  );

  assertEquals(argvLines(calls), ["agent list"]);
  const agent = onlyWrite(written, "agent");
  assertEquals(agent.data.agent, "claude");
  assertEquals(agent.data.status, "working");
});

Deno.test("start-agent: force starts anyway and passes agent argv after --", async () => {
  const { ctx } = fakeContext(model);
  const { run, calls } = tableRunner({
    "agent list": await fixtureStdout("agent_list"),
    "agent start": await fixtureStdout("agent_started"),
  });

  await runStartAgent(
    run,
    args("start-agent", {
      pane: "w1:p5",
      kind: "claude",
      name: "helper",
      force: true,
      agentArgs: ["--model", "opus"],
      timeoutMs: 20_000,
    }),
    ctx,
  );

  assertEquals(
    argvLines(calls)[1],
    "agent start helper --kind claude --pane w1:p5 --timeout 20000 -- --model opus",
  );
});

Deno.test("start-agent: an unknown kind fails with herdr's own error", async () => {
  const { ctx, written } = fakeContext(model);
  const { run } = tableRunner({
    "agent list": await fixtureStdout("agent_list"),
    "agent start": errorEnvelope(
      "unknown_agent_kind",
      "unknown agent kind: nope",
    ),
  });

  const err = await assertRejects(
    () =>
      runStartAgent(
        run,
        args("start-agent", { pane: "w1:p7", kind: "nope", name: "helper" }),
        ctx,
      ),
    HerdrError,
  );
  assertEquals(err.code, "unknown_agent_kind");
  assertEquals(written.length, 0);
});

// --- send-keys / send-text / run-command -------------------------------------

Deno.test("send-keys: forwards every key to every target", async () => {
  const { ctx, written } = fakeContext(model);
  const { run, calls } = tableRunner({ "pane send-keys": undefined });

  await runSendKeys(
    run,
    args("send-keys", {
      targets: ["w1:p5", "w1:p6"],
      keys: ["ctrl+c", "enter"],
    }),
    ctx,
  );

  assertEquals(argvLines(calls), [
    "pane send-keys w1:p5 ctrl+c enter",
    "pane send-keys w1:p6 ctrl+c enter",
  ]);
  assertEquals(onlyWrite(written, "action").data.changedCount, 2);
});

Deno.test("send-keys: via=agent addresses named agents", async () => {
  const { ctx } = fakeContext(model);
  const { run, calls } = tableRunner({ "agent send-keys": undefined });

  await runSendKeys(
    run,
    args("send-keys", { targets: ["docs-bot"], keys: ["esc"], via: "agent" }),
    ctx,
  );

  assertEquals(argvLines(calls), ["agent send-keys docs-bot esc"]);
});

Deno.test("send-text: types literal text and records its length", async () => {
  const { ctx, written } = fakeContext(model);
  const { run, calls } = tableRunner({ "pane send-text": undefined });

  await runSendText(
    run,
    args("send-text", { targets: ["w1:p5"], text: "hello there" }),
    ctx,
  );

  assertEquals(argvLines(calls), ["pane send-text w1:p5 hello there"]);
  const results = onlyWrite(written, "action").data.results as Record<
    string,
    unknown
  >[];
  assertEquals(results[0].detail, "sent 11 character(s)");
});

Deno.test("run-command: submits the command in each pane", async () => {
  const { ctx, written } = fakeContext(model);
  const { run, calls } = tableRunner({ "pane run": undefined });

  await runRunCommand(
    run,
    args("run-command", { targets: ["w1:p5", "w1:p6"], command: "git status" }),
    ctx,
  );

  assertEquals(argvLines(calls), [
    "pane run w1:p5 git status",
    "pane run w1:p6 git status",
  ]);
  assertEquals(onlyWrite(written, "action").data.method, "run-command");
});

Deno.test("run-command: a missing pane fails that target only", async () => {
  const { ctx, written } = fakeContext(model);
  const { run } = tableRunner({
    "pane run w1:p5": errorEnvelope("pane_not_found", "pane w1:p5 not found"),
    "pane run w1:p6": undefined,
  });

  await runRunCommand(
    run,
    args("run-command", { targets: ["w1:p5", "w1:p6"], command: "ls" }),
    ctx,
  );

  const action = onlyWrite(written, "action").data;
  assertEquals(action.failedCount, 1);
  assertEquals(action.okCount, 1);
});

// --- wait-output -------------------------------------------------------------

Deno.test("wait-output: waits on a literal match and writes the capture", async () => {
  const { ctx, written } = fakeContext(model);
  const { run, calls } = tableRunner({
    "pane wait-output": await fixtureStdout("output_matched"),
  });

  await runWaitOutput(
    run,
    args("wait-output", { pane: "w1:p5", match: "herdr-probe-ok" }),
    ctx,
  );

  assertEquals(
    argvLines(calls),
    ["pane wait-output w1:p5 --match herdr-probe-ok --source recent"],
  );
  const out = onlyWrite(written, "output").data;
  assertEquals(out.paneId, "w1:p5");
  assertEquals(out.source, "recent_unwrapped");
  assert(String(out.text).includes("herdr-probe-ok"));
});

Deno.test("wait-output: a regex with raw matching is forwarded", async () => {
  const { ctx } = fakeContext(model);
  const { run, calls } = tableRunner({
    "pane wait-output": await fixtureStdout("output_matched"),
  });

  await runWaitOutput(
    run,
    args("wait-output", {
      pane: "w1:p5",
      regex: "^done$",
      raw: true,
      lines: 200,
      timeoutMs: 15_000,
    }),
    ctx,
  );

  assertEquals(
    argvLines(calls)[0],
    "pane wait-output w1:p5 --regex ^done$ --source recent --lines 200 --timeout 15000 --raw",
  );
});

Deno.test("wait-output: neither or both of match/regex is refused", async () => {
  const { ctx } = fakeContext(model);
  const { run, calls } = tableRunner({});

  for (
    const raw of [
      { pane: "w1:p5" },
      { pane: "w1:p5", match: "a", regex: "b" },
    ]
  ) {
    const err = await assertRejects(
      () => runWaitOutput(run, args("wait-output", raw), ctx),
      HerdrError,
    );
    assertEquals(err.code, "invalid_argument");
  }
  assertEquals(calls.length, 0);
});

// --- create-workspace / create-tab -------------------------------------------

Deno.test("create-workspace: creates when no label matches", async () => {
  const { ctx, written } = fakeContext(model);
  const { run, calls } = tableRunner({
    "workspace list": await fixtureStdout("workspace_list"),
    "workspace create": await fixtureStdout("workspace_created"),
  });

  await runCreateWorkspace(
    run,
    args("create-workspace", {
      label: "review",
      cwd: "/home/dev/project",
      env: ["CI=1"],
    }),
    ctx,
  );

  assertEquals(
    argvLines(calls)[1],
    "workspace create --label review --cwd /home/dev/project --env CI=1 --no-focus",
  );
  const container = onlyWrite(written, "container").data;
  assertEquals(container.created, true);
  assertEquals(container.workspaceId, "w3");
  assertEquals(container.paneId, "w3:p1");
});

Deno.test("create-workspace: reuses an existing label without creating", async () => {
  const { ctx, written } = fakeContext(model);
  const { run, calls } = tableRunner({
    "workspace list": await fixtureStdout("workspace_list"),
  });

  await runCreateWorkspace(
    run,
    args("create-workspace", { label: "scratch" }),
    ctx,
  );

  assertEquals(argvLines(calls), ["workspace list"]);
  const container = onlyWrite(written, "container").data;
  assertEquals(container.created, false);
  assertEquals(container.workspaceId, "w2");
  assertEquals(container.tabId, "w2:t1");
});

Deno.test("create-workspace: reuse=false creates a second workspace with the same label", async () => {
  const { ctx, written } = fakeContext(model);
  const { run, calls } = tableRunner({
    "workspace create": await fixtureStdout("workspace_created"),
  });

  await runCreateWorkspace(
    run,
    args("create-workspace", { label: "scratch", reuse: false }),
    ctx,
  );

  assertEquals(argvLines(calls), [
    "workspace create --label scratch --no-focus",
  ]);
  assertEquals(onlyWrite(written, "container").data.created, true);
});

Deno.test("create-tab: reuses a label only within the requested workspace", async () => {
  const { ctx, written } = fakeContext(model);
  const { run, calls } = tableRunner({
    "tab list": await fixtureStdout("tab_list"),
    "tab create": await fixtureStdout("tab_created"),
  });

  // "docs" exists in w1 — asking for it in w2 must create, not reuse.
  await runCreateTab(
    run,
    args("create-tab", { workspace: "w2", label: "docs" }),
    ctx,
  );

  assertEquals(argvLines(calls), [
    "tab list --workspace w2",
    "tab create --label docs --workspace w2 --no-focus",
  ]);
  assertEquals(onlyWrite(written, "container").data.created, true);
});

Deno.test("create-tab: an existing label in the same workspace is reused", async () => {
  const { ctx, written } = fakeContext(model);
  const { run, calls } = tableRunner({
    "tab list": await fixtureStdout("tab_list"),
  });

  await runCreateTab(
    run,
    args("create-tab", { workspace: "w1", label: "docs" }),
    ctx,
  );

  assertEquals(argvLines(calls), ["tab list --workspace w1"]);
  const container = onlyWrite(written, "container").data;
  assertEquals(container.created, false);
  assertEquals(container.tabId, "w1:t6");
});

// --- split-pane --------------------------------------------------------------

Deno.test("split-pane: verifies the pane, then splits it", async () => {
  const { ctx, written } = fakeContext(model);
  const { run, calls } = tableRunner({
    "pane get w1:p5": await fixtureStdout("pane_info"),
    "pane split": await fixtureStdout("pane_split"),
  });

  await runSplitPane(
    run,
    args("split-pane", { pane: "w1:p5", direction: "down", ratio: 0.3 }),
    ctx,
  );

  assertEquals(argvLines(calls), [
    "pane get w1:p5",
    "pane split w1:p5 --direction down --ratio 0.3 --no-focus",
  ]);
  const container = onlyWrite(written, "container").data;
  assertEquals(container.paneId, "w1:p9");
  assertEquals(container.container, "pane");
});

Deno.test("split-pane: a missing pane fails before the layout is touched", async () => {
  const { ctx, written } = fakeContext(model);
  const { run, calls } = tableRunner({
    "pane get w9:p9": errorEnvelope("pane_not_found", "pane w9:p9 not found"),
  });

  const err = await assertRejects(
    () => runSplitPane(run, args("split-pane", { pane: "w9:p9" }), ctx),
    HerdrError,
  );
  assertEquals(err.code, "pane_not_found");
  assertEquals(calls.length, 1);
  assertEquals(written.length, 0);
});

// --- create-worktree ---------------------------------------------------------

Deno.test("create-worktree: creates when the branch has no worktree", async () => {
  const { ctx, written } = fakeContext(model);
  const { run, calls } = tableRunner({
    "worktree list": await fixtureStdout("worktree_list"),
    "worktree create": await fixtureStdout("worktree_created"),
  });

  await runCreateWorktree(
    run,
    args("create-worktree", {
      cwd: "/home/dev/project",
      branch: "fix/crash",
      base: "main",
      label: "fix-crash",
    }),
    ctx,
  );

  assertEquals(
    argvLines(calls)[1],
    "worktree create --cwd /home/dev/project --branch fix/crash --base main --label fix-crash --no-focus",
  );
  const container = onlyWrite(written, "container").data;
  assertEquals(container.created, true);
  assertEquals(container.branch, "fix/crash");
  assertEquals(container.workspaceId, "w4");
});

Deno.test("create-worktree: an existing but unopened worktree is opened", async () => {
  const { ctx, written } = fakeContext(model);
  const { run, calls } = tableRunner({
    "worktree list": await fixtureStdout("worktree_list"),
    "worktree open": await fixtureStdout("worktree_opened"),
  });

  await runCreateWorktree(
    run,
    args("create-worktree", {
      cwd: "/home/dev/project",
      branch: "feature/parser",
    }),
    ctx,
  );

  assertEquals(
    argvLines(calls)[1],
    "worktree open --cwd /home/dev/project --branch feature/parser --no-focus",
  );
  const container = onlyWrite(written, "container").data;
  assertEquals(container.created, false);
  assertEquals(container.workspaceId, "w5");
  assertEquals(container.reason, "opened an existing worktree");
});

Deno.test("create-worktree: a worktree already open is reported without any change", async () => {
  const { ctx, written } = fakeContext(model);
  const { run, calls } = tableRunner({
    "worktree list": await fixtureStdout("worktree_list"),
  });

  await runCreateWorktree(
    run,
    args("create-worktree", { cwd: "/home/dev/project", branch: "main" }),
    ctx,
  );

  assertEquals(argvLines(calls), ["worktree list --cwd /home/dev/project"]);
  const container = onlyWrite(written, "container").data;
  assertEquals(container.created, false);
  assertEquals(container.workspaceId, "w1");
});

Deno.test("create-worktree: outside a Git work tree herdr's error is surfaced", async () => {
  const { ctx, written } = fakeContext(model);
  const { run } = tableRunner({
    "worktree list": errorEnvelope(
      "not_git_worktree",
      "Herdr worktree actions require a path inside a Git work tree",
    ),
  });

  const err = await assertRejects(
    () =>
      runCreateWorktree(
        run,
        args("create-worktree", { cwd: "/tmp", branch: "x" }),
        ctx,
      ),
    HerdrError,
  );
  assertEquals(err.code, "not_git_worktree");
  assertEquals(written.length, 0);
});

Deno.test("create-worktree: neither branch nor path is refused", async () => {
  const { ctx } = fakeContext(model);
  const { run, calls } = tableRunner({});

  const err = await assertRejects(
    () =>
      runCreateWorktree(
        run,
        args("create-worktree", { cwd: "/home/dev/project" }),
        ctx,
      ),
    HerdrError,
  );
  assertEquals(err.code, "invalid_argument");
  assertEquals(calls.length, 0);
});

// --- close -------------------------------------------------------------------

Deno.test("close: closes an existing workspace", async () => {
  const { ctx, written } = fakeContext(model);
  const { run, calls } = tableRunner({
    "workspace list": await fixtureStdout("workspace_list"),
    "workspace close": await fixtureStdout("ok"),
  });

  await runClose(
    run,
    args("close", { container: "workspace", id: "w2" }),
    ctx,
  );

  assertEquals(argvLines(calls), ["workspace list", "workspace close w2"]);
  const action = onlyWrite(written, "action").data;
  assertEquals(action.changed, true);
  assertEquals(action.method, "close");
});

Deno.test("close: an id that is already gone is a recorded no-op", async () => {
  const { ctx, written } = fakeContext(model);
  const { run, calls } = tableRunner({
    "workspace list": await fixtureStdout("workspace_list"),
  });

  await runClose(
    run,
    args("close", { container: "workspace", id: "w9" }),
    ctx,
  );

  assertEquals(argvLines(calls), ["workspace list"]);
  const action = onlyWrite(written, "action").data;
  assertEquals(action.changed, false);
  assertEquals(action.okCount, 1);
});

Deno.test("close: missingOk=false turns an absent id into an error", async () => {
  const { ctx, written } = fakeContext(model);
  const { run } = tableRunner({
    "pane list": await fixtureStdout("pane_list"),
  });

  const err = await assertRejects(
    () =>
      runClose(
        run,
        args("close", { container: "pane", id: "w9:p9", missingOk: false }),
        ctx,
      ),
    HerdrError,
  );
  assertEquals(err.code, "pane_not_found");
  assertEquals(written.length, 0);
});

Deno.test("close: refuses to close the tab hosting the caller", async () => {
  const { ctx, written } = fakeContext(model);
  const { run, calls } = tableRunner({});

  const err = await assertRejects(
    () =>
      runClose(
        run,
        args("close", { container: "tab", id: "w1:t5" }),
        ctx,
        fakeEnv({ HERDR_TAB_ID: "w1:t5", HERDR_PANE_ID: "w1:p5" }),
      ),
    HerdrError,
  );
  assertEquals(err.code, "self_close_refused");
  assertEquals(calls.length, 0);
  assertEquals(written.length, 0);
});

Deno.test("close: force overrides the self guard", async () => {
  const { ctx, written } = fakeContext(model);
  const { run } = tableRunner({
    "pane list": await fixtureStdout("pane_list"),
    "pane close": await fixtureStdout("ok"),
  });

  await runClose(
    run,
    args("close", { container: "pane", id: "w1:p5", force: true }),
    ctx,
    fakeEnv({ HERDR_PANE_ID: "w1:p5" }),
  );

  assertEquals(onlyWrite(written, "action").data.changed, true);
});

// --- notify ------------------------------------------------------------------

Deno.test("notify: a shown toast is recorded as a change", async () => {
  const { ctx, written } = fakeContext(model);
  const { run, calls } = tableRunner({
    "notification show": await fixtureStdout("notification_shown"),
  });

  await runNotify(
    run,
    args("notify", { title: "build done", body: "green", sound: "done" }),
    ctx,
  );

  assertEquals(
    argvLines(calls),
    ["notification show build done --body green --position top-right --sound done"],
  );
  const action = onlyWrite(written, "action").data;
  assertEquals(action.changed, true);
});

Deno.test("notify: a suppressed toast succeeds but reports why", async () => {
  const { ctx, written } = fakeContext(model);
  const { run } = tableRunner({
    "notification show": await fixtureStdout("notification_disabled"),
  });

  await runNotify(run, args("notify", { title: "hi" }), ctx);

  const action = onlyWrite(written, "action").data;
  assertEquals(action.changed, false);
  const results = action.results as Record<string, unknown>[];
  assertEquals(results[0].status, "suppressed");
  assert(
    String(results[0].detail).includes("disabled"),
    String(results[0].detail),
  );
});

// --- server lifecycle --------------------------------------------------------

Deno.test("server-stop: stops a running server when we are not inside it", async () => {
  const { ctx, written } = fakeContext(model);
  const { run, calls } = tableRunner({
    "status": await statusFixture(),
    "server stop": await fixtureStdout("ok"),
  });

  await runServerStop(run, args("server-stop"), ctx, fakeEnv());

  assertEquals(argvLines(calls), ["status", "server stop"]);
  const action = onlyWrite(written, "action").data;
  assertEquals(action.method, "server-stop");
  assertEquals(action.changed, true);
});

Deno.test("server-stop: an already-stopped server is a recorded no-op", async () => {
  const { ctx, written } = fakeContext(model);
  const { run, calls } = tableRunner({
    "status": "client:\n  version: 0.8.0\n\nserver:\n  status: not running\n",
  });

  await runServerStop(run, args("server-stop"), ctx, fakeEnv());

  assertEquals(argvLines(calls), ["status"]);
  const action = onlyWrite(written, "action").data;
  assertEquals(action.changed, false);
  assertEquals(action.okCount, 1);
});

Deno.test("server-stop: missingOk=false turns a stopped server into an error", async () => {
  const { ctx, written } = fakeContext(model);
  const { run } = tableRunner({
    "status": "server:\n  status: not running\n",
  });

  const err = await assertRejects(
    () =>
      runServerStop(
        run,
        args("server-stop", { missingOk: false }),
        ctx,
        fakeEnv(),
      ),
    HerdrError,
  );
  assertEquals(err.code, "server_not_running");
  assertEquals(written.length, 0);
});

Deno.test("server-stop: refuses to stop the local server hosting this method", async () => {
  const { ctx, written } = fakeContext(model);
  const { run, calls } = tableRunner({});

  const err = await assertRejects(
    () =>
      runServerStop(
        run,
        args("server-stop"),
        ctx,
        fakeEnv({ HERDR_PANE_ID: "w1:p4" }),
      ),
    HerdrError,
  );
  assertEquals(err.code, "self_stop_refused");
  // Refused before even asking herdr for its status.
  assertEquals(calls.length, 0);
  assertEquals(written.length, 0);
});

Deno.test("server-stop: force overrides the self guard", async () => {
  const { ctx, written } = fakeContext(model);
  const { run } = tableRunner({
    "status": await statusFixture(),
    "server stop": await fixtureStdout("ok"),
  });

  await runServerStop(
    run,
    args("server-stop", { force: true }),
    ctx,
    fakeEnv({ HERDR_PANE_ID: "w1:p4" }),
  );

  assertEquals(onlyWrite(written, "action").data.changed, true);
});

Deno.test("server-reload-config: validates the config before reloading it", async () => {
  const { ctx, written } = fakeContext(model);
  const { run, calls } = tableRunner({
    "config check": "config: ok\n",
    "status": await statusFixture(),
    "server reload-config": await fixtureStdout("ok"),
  });

  await runServerReloadConfig(run, args("server-reload-config"), ctx);

  assertEquals(argvLines(calls), [
    "config check",
    "status",
    "server reload-config",
  ]);
  const action = onlyWrite(written, "action").data;
  assertEquals(action.changed, true);
  const results = action.results as Record<string, unknown>[];
  assertEquals(results[0].detail, "config: ok");
});

Deno.test("server-reload-config: an invalid config is refused, never reloaded", async () => {
  const { ctx, written } = fakeContext(model);
  const { run, calls } = tableRunner({
    "config check": { code: 1, stdout: "", stderr: "bad table on line 4\n" },
  });

  const err = await assertRejects(
    () => runServerReloadConfig(run, args("server-reload-config"), ctx),
    HerdrError,
  );
  assertEquals(err.code, "invalid_config");
  // The reload itself never ran — that is the whole point of the gate.
  assertEquals(argvLines(calls), ["config check"]);
  assertEquals(written.length, 0);
});

Deno.test("server-reload-config: force reloads despite a failed validation", async () => {
  const { ctx, written } = fakeContext(model);
  const { run, calls } = tableRunner({
    "config check": { code: 1, stdout: "", stderr: "bad table on line 4\n" },
    "status": await statusFixture(),
    "server reload-config": await fixtureStdout("ok"),
  });

  await runServerReloadConfig(
    run,
    args("server-reload-config", { force: true }),
    ctx,
  );

  assertEquals(argvLines(calls).at(-1), "server reload-config");
  const results = onlyWrite(written, "action").data.results as Record<
    string,
    unknown
  >[];
  assert(String(results[0].detail).includes("ignored invalid config"));
});

Deno.test("server-reload-config: nothing to reload when no server runs", async () => {
  const { ctx, written } = fakeContext(model);
  const { run, calls } = tableRunner({
    "config check": "config: ok\n",
    "status": "server:\n  status: not running\n",
  });

  await runServerReloadConfig(run, args("server-reload-config"), ctx);

  assertEquals(argvLines(calls), ["config check", "status"]);
  assertEquals(onlyWrite(written, "action").data.changed, false);
});

Deno.test("server-live-handoff: hands off when a server is running", async () => {
  const { ctx, written } = fakeContext(model);
  const { run, calls } = tableRunner({
    "status": await statusFixture(),
    "server live-handoff": await fixtureStdout("ok"),
  });

  await runServerLiveHandoff(run, args("server-live-handoff"), ctx);

  assertEquals(argvLines(calls), ["status", "server live-handoff"]);
  assertEquals(onlyWrite(written, "action").data.changed, true);
});

Deno.test("server-live-handoff: fails loudly when there is nothing to hand off", async () => {
  const { ctx, written } = fakeContext(model);
  const { run } = tableRunner({ "status": "server:\n  status: not running\n" });

  const err = await assertRejects(
    () => runServerLiveHandoff(run, args("server-live-handoff"), ctx),
    HerdrError,
  );
  assertEquals(err.code, "server_not_running");
  assertEquals(written.length, 0);
});

// --- agent manifests ---------------------------------------------------------

Deno.test("agent-manifests: reads the manifest inventory without changing it", async () => {
  const { ctx, written } = fakeContext(model);
  const { run, calls } = tableRunner({
    "server agent-manifests --json": await fixtureStdout(
      "agent_manifest_status",
    ),
  });

  await runAgentManifests(run, args("agent-manifests"), ctx);

  assertEquals(argvLines(calls), ["server agent-manifests --json"]);
  const manifests = onlyWrite(written, "manifests").data;
  assertEquals(manifests.total, 3);
  assertEquals(manifests.changedAgents, []);
  assertEquals(manifests.target, "local");
});

Deno.test("update-agent-manifests: names exactly the agents whose version moved", async () => {
  const { ctx, written } = fakeContext(model);
  const { run, calls } = tableRunner({
    "server agent-manifests --json": await fixtureStdout(
      "agent_manifest_status",
    ),
    "server update-agent-manifests --json": await fixtureStdout(
      "agent_manifest_status_updated",
    ),
  });

  await runUpdateAgentManifests(run, args("update-agent-manifests"), ctx);

  assertEquals(argvLines(calls), [
    "server agent-manifests --json",
    "server update-agent-manifests --json",
  ]);
  const manifests = onlyWrite(written, "manifests").data;
  // Only claude moved 2026.08.04.1 -> 2026.08.08.1 in the fixtures.
  assertEquals(manifests.changedAgents, ["claude"]);
  assertEquals(manifests.lastResult, "updated");
});

Deno.test("update-agent-manifests: an unreadable baseline still updates, reporting no diff", async () => {
  const { ctx, written } = fakeContext(model);
  const { run } = tableRunner({
    "server agent-manifests --json": errorEnvelope("socket_error", "no server"),
    "server update-agent-manifests --json": await fixtureStdout(
      "agent_manifest_status_updated",
    ),
  });

  await runUpdateAgentManifests(run, args("update-agent-manifests"), ctx);

  const manifests = onlyWrite(written, "manifests").data;
  assertEquals(manifests.changedAgents, []);
  assertEquals(manifests.total, 3);
});

Deno.test("update-agent-manifests: a failed fetch fails the method", async () => {
  const { ctx, written } = fakeContext(model);
  const { run } = tableRunner({
    "server agent-manifests --json": await fixtureStdout(
      "agent_manifest_status",
    ),
    "server update-agent-manifests --json": errorEnvelope(
      "manifest_fetch_failed",
      "could not reach the manifest host",
    ),
  });

  const err = await assertRejects(
    () => runUpdateAgentManifests(run, args("update-agent-manifests"), ctx),
    HerdrError,
  );
  assertEquals(err.code, "manifest_fetch_failed");
  assertEquals(written.length, 0);
});

Deno.test("reload-agent-manifests: reads the state back rather than assuming it", async () => {
  const { ctx, written } = fakeContext(model);
  const { run, calls } = tableRunner({
    "server reload-agent-manifests": undefined,
    "server agent-manifests --json": await fixtureStdout(
      "agent_manifest_status",
    ),
  });

  await runReloadAgentManifests(run, args("reload-agent-manifests"), ctx);

  // The reload prints nothing, so the follow-up read is what proves it worked.
  assertEquals(argvLines(calls), [
    "server reload-agent-manifests",
    "server agent-manifests --json",
  ]);
  assertEquals(onlyWrite(written, "manifests").data.total, 3);
});

// --- sessions ----------------------------------------------------------------

Deno.test("session-stop: stops a running named session", async () => {
  const { ctx, written } = fakeContext(model);
  const { run, calls } = tableRunner({
    "session list --json": await fixtureStdout("session_list_two"),
    "session stop": await fixtureStdout("ok"),
  });

  await runSessionStop(
    run,
    args("session-stop", { name: "default" }),
    ctx,
    fakeEnv(),
  );

  assertEquals(argvLines(calls), [
    "session list --json",
    "session stop default --json",
  ]);
  assertEquals(onlyWrite(written, "action").data.changed, true);
});

Deno.test("session-stop: an already-stopped session is a no-op", async () => {
  const { ctx, written } = fakeContext(model);
  const { run, calls } = tableRunner({
    "session list --json": await fixtureStdout("session_list_two"),
  });

  await runSessionStop(
    run,
    args("session-stop", { name: "build" }),
    ctx,
    fakeEnv(),
  );

  assertEquals(argvLines(calls), ["session list --json"]);
  const action = onlyWrite(written, "action").data;
  assertEquals(action.changed, false);
  assertEquals(action.okCount, 1);
});

Deno.test("session-stop: an unknown session errors when missingOk is off", async () => {
  const { ctx, written } = fakeContext(model);
  const { run } = tableRunner({
    "session list --json": await fixtureStdout("session_list_two"),
  });

  const err = await assertRejects(
    () =>
      runSessionStop(
        run,
        args("session-stop", { name: "ghost", missingOk: false }),
        ctx,
        fakeEnv(),
      ),
    HerdrError,
  );
  assertEquals(err.code, "session_not_found");
  assertEquals(written.length, 0);
});

Deno.test("session-stop: refuses to stop the session running this method", async () => {
  const { ctx, written } = fakeContext(model);
  const { run, calls } = tableRunner({});

  const err = await assertRejects(
    () =>
      runSessionStop(
        run,
        args("session-stop", { name: "default" }),
        ctx,
        fakeEnv({ HERDR_PANE_ID: "w1:p4" }),
      ),
    HerdrError,
  );
  assertEquals(err.code, "self_stop_refused");
  assertEquals(calls.length, 0);
  assertEquals(written.length, 0);
});

Deno.test("session-stop: a named instance guards its own session, not 'default'", async () => {
  const { ctx, written } = fakeContext(model, { session: "build" });
  const { run } = tableRunner({
    "session list --json": await fixtureStdout("session_list_two"),
    "session stop": await fixtureStdout("ok"),
  });

  // We are on session "build", so stopping "default" is allowed...
  await runSessionStop(
    run,
    args("session-stop", { name: "default" }),
    ctx,
    fakeEnv({ HERDR_PANE_ID: "w1:p4" }),
  );
  assertEquals(onlyWrite(written, "action").data.changed, true);

  // ...but stopping "build" is not.
  const second = fakeContext(model, { session: "build" });
  const err = await assertRejects(
    () =>
      runSessionStop(
        run,
        args("session-stop", { name: "build" }),
        second.ctx,
        fakeEnv({ HERDR_PANE_ID: "w1:p4" }),
      ),
    HerdrError,
  );
  assertEquals(err.code, "self_stop_refused");
});

Deno.test("session-delete: deletes a stopped session", async () => {
  const { ctx, written } = fakeContext(model);
  const { run, calls } = tableRunner({
    "session list --json": await fixtureStdout("session_list_two"),
    "session delete": await fixtureStdout("ok"),
  });

  await runSessionDelete(
    run,
    args("session-delete", { name: "build" }),
    ctx,
    fakeEnv(),
  );

  assertEquals(argvLines(calls), [
    "session list --json",
    "session delete build --json",
  ]);
  assertEquals(onlyWrite(written, "action").data.changed, true);
});

Deno.test("session-delete: refuses a session that is still running", async () => {
  const { ctx, written } = fakeContext(model);
  const { run, calls } = tableRunner({
    "session list --json": await fixtureStdout("session_list_two"),
  });

  const err = await assertRejects(
    () =>
      runSessionDelete(
        run,
        args("session-delete", { name: "default" }),
        ctx,
        fakeEnv(),
      ),
    HerdrError,
  );
  assertEquals(err.code, "session_running");
  assertEquals(argvLines(calls), ["session list --json"]);
  assertEquals(written.length, 0);
});

Deno.test("session-delete: force deletes a running session", async () => {
  const { ctx, written } = fakeContext(model);
  const { run } = tableRunner({
    "session list --json": await fixtureStdout("session_list_two"),
    "session delete": await fixtureStdout("ok"),
  });

  await runSessionDelete(
    run,
    args("session-delete", { name: "default", force: true }),
    ctx,
    fakeEnv(),
  );

  assertEquals(onlyWrite(written, "action").data.changed, true);
});

Deno.test("session-delete: an unknown session is a recorded no-op", async () => {
  const { ctx, written } = fakeContext(model);
  const { run } = tableRunner({
    "session list --json": await fixtureStdout("session_list_two"),
  });

  await runSessionDelete(
    run,
    args("session-delete", { name: "ghost" }),
    ctx,
    fakeEnv(),
  );

  const action = onlyWrite(written, "action").data;
  assertEquals(action.changed, false);
  assertEquals(action.okCount, 1);
});
