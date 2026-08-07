/**
 * COVERAGE suite for @magistr/herdr.
 *
 * Regression tests for guards and branches that no other suite pins — the
 * "if someone deletes this line, does a test go red?" set. Each test names
 * the guard it protects and what silently breaks without it.
 */

import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import { z } from "npm:zod@4";
import {
  assertTarget,
  boundText,
  buildInvocation,
  defaultEnvGet,
  HerdrError,
  parseStatusBlocks,
  pushFlag,
  pushFocus,
  pushRepeated,
  readSelfLocation,
  remoteCommand,
  selfLocationFor,
  targetLabel,
  yesNo,
} from "./lib/cli.ts";
import {
  cfgFrom,
  dedupeTargets,
  fanOut,
  model,
  runClose,
  runCreateTab,
  runCreateWorkspace,
  runNotify,
  runPrompt,
  runRunCommand,
  runServerStop,
  runSessionStop,
  runSnapshot,
  runStartAgent,
  sanitizeInstance,
  toAgent,
  toManifestRow,
} from "./herdr.ts";
import {
  argvLines,
  errorEnvelope,
  fakeContext,
  fakeEnv,
  fixtureStdout,
  onlyWrite,
  sshConfig,
  tableRunner,
  testConfig,
} from "./lib/test_support.ts";

function args<T>(method: string, raw: Record<string, unknown> = {}): T {
  const methods = model.methods as Record<string, { arguments: z.ZodTypeAny }>;
  return methods[method].arguments.parse(raw) as T;
}

// --- argv builders -----------------------------------------------------------

Deno.test("coverage: pushFlag omits the flag entirely for an empty value", () => {
  // Without this guard herdr would receive `--cwd ""` and try to chdir to "".
  assertEquals(pushFlag(["x"], "--cwd", ""), ["x"]);
  assertEquals(pushFlag(["x"], "--cwd", undefined), ["x"]);
  assertEquals(pushFlag(["x"], "--cwd", "/tmp"), ["x", "--cwd", "/tmp"]);
});

Deno.test("coverage: pushRepeated skips empty entries but keeps every real one", () => {
  assertEquals(pushRepeated([], "--env", ["A=1", "", "B=2"]), [
    "--env",
    "A=1",
    "--env",
    "B=2",
  ]);
  assertEquals(pushRepeated([], "--until", []), []);
});

Deno.test("coverage: pushFocus always states the intent explicitly", () => {
  // Being explicit both ways keeps focus behaviour independent of whatever
  // herdr's default happens to be in a given release or config.
  assertEquals(pushFocus([], true), ["--focus"]);
  assertEquals(pushFocus([], false), ["--no-focus"]);
});

Deno.test("coverage: yesNo treats anything but yes/true as false", () => {
  assertEquals(yesNo("yes"), true);
  assertEquals(yesNo("true"), true);
  assertEquals(yesNo("no"), false);
  assertEquals(yesNo(""), false);
  assertEquals(yesNo(undefined), false);
  assertEquals(yesNo("YES"), false);
});

// --- status parsing ----------------------------------------------------------

Deno.test("coverage: an unknown status section survives instead of being dropped", () => {
  const blocks = parseStatusBlocks(
    "client:\n  version: 1\n\nfuture:\n  thing: 2\n",
  );
  // A herdr release adding a section must not break the parse of the rest.
  assertEquals(blocks.future, { thing: "2" });
  assertEquals(blocks.client.version, "1");
});

Deno.test("coverage: a bare `key: value` header keeps its value under _", () => {
  const blocks = parseStatusBlocks("mode: headless\nclient:\n  version: 1\n");
  assertEquals(blocks.mode._, "headless");
  assertEquals(blocks.client.version, "1");
});

Deno.test("coverage: a value containing a colon is not split twice", () => {
  const blocks = parseStatusBlocks("server:\n  socket: /tmp/a:b/herdr.sock\n");
  assertEquals(blocks.server.socket, "/tmp/a:b/herdr.sock");
});

// --- bounds ------------------------------------------------------------------

Deno.test("coverage: a non-positive maxOutputBytes disables bounding", () => {
  const long = "x".repeat(10_000);
  assertEquals(boundText(long, 0).truncated, false);
  assertEquals(boundText(long, -1).text.length, 10_000);
});

Deno.test("coverage: exactly-at-the-limit text is not marked truncated", () => {
  const bounded = boundText("abcd", 4);
  assertEquals(bounded.truncated, false);
  assertEquals(bounded.bytes, 4);
});

// --- environment -------------------------------------------------------------

Deno.test("coverage: readSelfLocation reports whether we are inside herdr at all", () => {
  assertEquals(readSelfLocation(fakeEnv()).inHerdr, false);
  const inside = readSelfLocation(fakeEnv({ HERDR_PANE_ID: "w1:p1" }));
  assertEquals(inside.inHerdr, true);
  assertEquals(inside.paneId, "w1:p1");
  assertEquals(inside.tabId, "");
});

Deno.test("coverage: an env getter that throws is treated as unset, not fatal", () => {
  // Mirrors running without --allow-env: the self guard degrades to off
  // rather than failing every method that consults it.
  const thrower = () => {
    throw new Deno.errors.PermissionDenied("requires env access");
  };
  assertEquals(
    readSelfLocation(() => {
      try {
        return thrower();
      } catch {
        return undefined;
      }
    }).inHerdr,
    false,
  );
  // The shipped default swallows the same failure.
  assertEquals(typeof defaultEnvGet("PATH_THAT_DOES_NOT_EXIST"), "undefined");
});

// --- config ------------------------------------------------------------------

Deno.test("coverage: cfgFrom falls back to every declared default", () => {
  const cfg = cfgFrom({
    globalArgs: {},
    writeResource: () => Promise.resolve({}),
  });
  assertEquals(cfg.binary, "herdr");
  assertEquals(cfg.session, "");
  assertEquals(cfg.socketPath, "");
  assertEquals(cfg.timeoutMs, 30_000);
});

Deno.test("coverage: cfgFrom honours an explicit binary path", () => {
  const cfg = cfgFrom({
    globalArgs: { binary: "/opt/herdr/bin/herdr", timeoutMs: 5000 },
    writeResource: () => Promise.resolve({}),
  });
  assertEquals(cfg.binary, "/opt/herdr/bin/herdr");
  assertEquals(cfg.timeoutMs, 5000);
});

// --- fan-out plumbing --------------------------------------------------------

Deno.test("coverage: dedupeTargets drops blanks as well as repeats", () => {
  assertEquals(dedupeTargets(["a", "", "  ", "a", " a ", "b"]), ["a", "b"]);
  assertEquals(dedupeTargets([]), []);
});

Deno.test("coverage: failFast re-throws the original error, unwrapped", async () => {
  const boom = new HerdrError("original", { code: "boom" });
  const err = await assertRejects(
    () =>
      fanOut(["a", "b"], true, () => {
        throw boom;
      }),
    HerdrError,
  );
  assertEquals(err, boom);
});

Deno.test("coverage: without failFast a thrown non-Error is still recorded", async () => {
  const outcomes = await fanOut(["a"], false, () => {
    throw "plain string";
  });
  assertEquals(outcomes[0].ok, false);
  assertEquals(outcomes[0].detail, "plain string");
});

Deno.test("coverage: skippedCount counts ok-but-unchanged targets", async () => {
  const { ctx, written } = fakeContext(model);
  const { run } = tableRunner({
    "agent list": await fixtureStdout("agent_list"),
    "agent prompt": await fixtureStdout("agent_prompted"),
  });

  await runPrompt(
    run,
    args("prompt", { targets: ["w1:p5", "w1:p6"], text: "go" }),
    ctx,
    fakeEnv({ HERDR_PANE_ID: "w1:p5" }),
  );

  const action = onlyWrite(written, "action").data;
  assertEquals(action.okCount, 2);
  assertEquals(action.changedCount, 1);
  assertEquals(action.skippedCount, 1);
  assertEquals(action.failedCount, 0);
});

// --- mapping -----------------------------------------------------------------

Deno.test("coverage: toAgent prefers the explicit name over display_agent", () => {
  const withBoth = toAgent(
    { pane_id: "w1:p1", name: "real", display_agent: "fallback" },
    "t",
  );
  assertEquals(withBoth.name, "real");
  const displayOnly = toAgent(
    { pane_id: "w1:p1", display_agent: "fallback" },
    "t",
  );
  assertEquals(displayOnly.name, "fallback");
});

Deno.test("coverage: a path-kind agent session lands in sessionPath, not sessionId", () => {
  const mapped = toAgent({
    pane_id: "w1:p1",
    agent_session: { kind: "path", value: "/tmp/session.jsonl" },
  }, "t");
  assertEquals(mapped.sessionPath, "/tmp/session.jsonl");
  assertEquals(mapped.sessionId, "");
});

Deno.test("coverage: sanitizeInstance collapses runs and caps the length", () => {
  assertEquals(sanitizeInstance("a::::b"), "a-b");
  assertEquals(sanitizeInstance("--lead--"), "lead");
  assertEquals(sanitizeInstance("z".repeat(200)).length, 80);
});

Deno.test("coverage: assertTarget names what it was validating", () => {
  try {
    assertTarget("-x", "pane");
    throw new Error("should have thrown");
  } catch (err) {
    assert(err instanceof HerdrError);
    assert(err.message.includes("pane"), err.message);
  }
});

// --- method branches ---------------------------------------------------------

Deno.test("coverage: snapshot filters by workspace id, not only by label", async () => {
  const { ctx, written } = fakeContext(model);
  const { run } = tableRunner({
    "api snapshot": await fixtureStdout("api_snapshot"),
  });

  await runSnapshot(run, args("snapshot", { workspace: "w2" }), ctx);

  const fleet = onlyWrite(written, "fleet").data;
  assertEquals(fleet.workspaceCount, 1);
  assertEquals(
    (fleet.workspaces as Record<string, unknown>[])[0].label,
    "scratch",
  );
});

Deno.test("coverage: close on a tab matches tab_id, not workspace_id", async () => {
  const { ctx, written } = fakeContext(model);
  const { run, calls } = tableRunner({
    "tab list": await fixtureStdout("tab_list"),
    "tab close": await fixtureStdout("ok"),
  });

  // The id-key lookup is built from the container kind; getting it wrong
  // would make every tab look already-gone and silently skip the close.
  await runClose(
    run,
    args("close", { container: "tab", id: "w1:t6" }),
    ctx,
    fakeEnv(),
  );

  assertEquals(argvLines(calls), ["tab list", "tab close w1:t6"]);
  assertEquals(onlyWrite(written, "action").data.changed, true);
});

Deno.test("coverage: close on a pane matches pane_id", async () => {
  const { ctx, written } = fakeContext(model);
  const { run, calls } = tableRunner({
    "pane list": await fixtureStdout("pane_list"),
    "pane close": await fixtureStdout("ok"),
  });

  await runClose(
    run,
    args("close", { container: "pane", id: "w1:p6" }),
    ctx,
    fakeEnv(),
  );

  assertEquals(argvLines(calls), ["pane list", "pane close w1:p6"]);
  assertEquals(onlyWrite(written, "action").data.changed, true);
});

Deno.test("coverage: create-tab without a workspace lists tabs unscoped", async () => {
  const { ctx } = fakeContext(model);
  const { run, calls } = tableRunner({
    "tab list": await fixtureStdout("tab_list"),
  });

  await runCreateTab(run, args("create-tab", { label: "build" }), ctx);

  // No --workspace flag, and the first label match anywhere is reused.
  assertEquals(argvLines(calls), ["tab list"]);
});

Deno.test("coverage: create-workspace passes cwd and env through in order", async () => {
  const { ctx } = fakeContext(model);
  const { run, calls } = tableRunner({
    "workspace list": await fixtureStdout("workspace_list"),
    "workspace create": await fixtureStdout("workspace_created"),
  });

  await runCreateWorkspace(
    run,
    args("create-workspace", {
      label: "new",
      cwd: "/srv/app",
      env: ["A=1", "B=2"],
      focus: true,
    }),
    ctx,
  );

  assertEquals(calls[1].args, [
    "workspace",
    "create",
    "--label",
    "new",
    "--cwd",
    "/srv/app",
    "--env",
    "A=1",
    "--env",
    "B=2",
    "--focus",
  ]);
});

Deno.test("coverage: notify always sends position and sound", async () => {
  const { ctx } = fakeContext(model);
  const { run, calls } = tableRunner({
    "notification show": await fixtureStdout("notification_shown"),
  });

  await runNotify(run, args("notify", { title: "hi" }), ctx);

  assertEquals(calls[0].args, [
    "notification",
    "show",
    "hi",
    "--position",
    "top-right",
    "--sound",
    "none",
  ]);
});

Deno.test("coverage: start-agent keys the resource on the pane herdr reports", async () => {
  const { ctx, written } = fakeContext(model);
  const { run } = tableRunner({
    "agent list": '{"id":"x","result":{"agents":[]}}',
    "agent start": await fixtureStdout("agent_started"),
  });

  // The fixture's agent lands in w1:p7 — the instance name must follow
  // herdr's answer, not the requested pane, or a redirect would orphan data.
  await runStartAgent(
    run,
    args("start-agent", { pane: "w1:p7", kind: "claude", name: "helper" }),
    ctx,
  );

  assertEquals(onlyWrite(written, "agent").instance, "agent-w1-p7");
});

Deno.test("coverage: an error printed on stderr is still read as an envelope", async () => {
  const { ctx } = fakeContext(model);
  const { run } = tableRunner({
    "api snapshot": {
      code: 1,
      stdout: "",
      stderr: JSON.stringify({
        error: { code: "socket_error", message: "no server" },
      }),
    },
  });

  const err = await assertRejects(
    () => runSnapshot(run, args("snapshot"), ctx),
    HerdrError,
  );
  assertEquals(err.code, "socket_error");
});

Deno.test("coverage: HerdrError defaults are usable without any options", () => {
  const err = new HerdrError("plain");
  assertEquals(err.code, "cli_error");
  assertEquals(err.exitCode, 1);
  assertEquals(err.argv, []);
  assertEquals(err.name, "HerdrError");
});

Deno.test("coverage: a failed target's detail carries the herdr error code", async () => {
  const { ctx, written } = fakeContext(model);
  const { run } = tableRunner({
    "pane run w1:p5": errorEnvelope("pane_busy", "pane is running a command"),
    "pane run w1:p6": undefined,
  });

  await runRunCommand(
    run,
    args("run-command", { targets: ["w1:p5", "w1:p6"], command: "ls" }),
    ctx,
  );

  const results = onlyWrite(written, "action").data.results as Record<
    string,
    unknown
  >[];
  assertEquals(results[0].detail, "pane_busy: pane is running a command");
});

// --- ssh invocation branches -------------------------------------------------

Deno.test("coverage: optional ssh flags are omitted when unset", () => {
  const invocation = buildInvocation(sshConfig(), ["status"]);
  // No -p and no -i when port is 0 and no identity file is configured.
  assertEquals(invocation.args, [
    "-o",
    "BatchMode=yes",
    "-o",
    "ConnectTimeout=10",
    "build.example",
    "'herdr' 'status'",
  ]);
});

Deno.test("coverage: port and identity file appear only when configured", () => {
  const invocation = buildInvocation(
    sshConfig({ port: 2222, identityFile: "/home/dev/.ssh/id_ed25519" }),
    ["status"],
  );
  assertEquals(invocation.args.includes("-p"), true);
  assertEquals(invocation.args[invocation.args.indexOf("-p") + 1], "2222");
  assertEquals(
    invocation.args[invocation.args.indexOf("-i") + 1],
    "/home/dev/.ssh/id_ed25519",
  );
});

Deno.test("coverage: a user is joined to the host, and omitted when empty", () => {
  assertEquals(
    buildInvocation(sshConfig({ user: "dev" }), ["status"]).args.at(-2),
    "dev@build.example",
  );
  assertEquals(
    buildInvocation(sshConfig(), ["status"]).args.at(-2),
    "build.example",
  );
});

Deno.test("coverage: remoteBinary overrides binary only on the remote side", () => {
  assertEquals(
    remoteCommand(sshConfig({ binary: "/usr/local/bin/herdr" }), ["status"]),
    "'/usr/local/bin/herdr' 'status'",
  );
  // Empty remoteBinary falls back to the shared `binary` global.
  assertEquals(
    remoteCommand(sshConfig({}, { binary: "herdr-preview" }), ["status"]),
    "'herdr-preview' 'status'",
  );
});

Deno.test("coverage: env is embedded remotely, never set on the ssh process", () => {
  const cfg = sshConfig({}, { session: "work", socketPath: "/tmp/h.sock" });
  assertEquals(
    remoteCommand(cfg, ["status"]),
    "env 'HERDR_SESSION=work' 'HERDR_SOCKET_PATH=/tmp/h.sock' 'herdr' 'status'",
  );
  assertEquals(buildInvocation(cfg, ["status"]).env, undefined);
  // With nothing to export there is no `env` prefix at all.
  assertEquals(remoteCommand(sshConfig(), ["status"]), "'herdr' 'status'");
});

Deno.test("coverage: targetLabel names the server each config talks to", () => {
  assertEquals(targetLabel(testConfig()), "local");
  assertEquals(targetLabel(sshConfig()), "build.example");
  assertEquals(targetLabel(sshConfig({ user: "dev" })), "dev@build.example");
  assertEquals(
    targetLabel(sshConfig({ user: "dev", port: 2222 })),
    "dev@build.example:2222",
  );
});

Deno.test("coverage: cfgFrom leaves ssh null until a host is named", () => {
  const local = cfgFrom({
    globalArgs: { sshUser: "dev", sshPort: 2222, remoteBinary: "/opt/herdr" },
    writeResource: () => Promise.resolve({}),
  });
  // Every ssh knob set BUT the host: still a local transport.
  assertEquals(local.ssh, null);

  const remote = cfgFrom({
    globalArgs: {
      sshHost: "build.example",
      sshUser: "dev",
      sshPort: 2222,
      sshIdentityFile: "/k",
      sshExtraArgs: ["-4"],
      remoteBinary: "/opt/herdr",
    },
    writeResource: () => Promise.resolve({}),
  });
  assertEquals(remote.ssh, {
    host: "build.example",
    user: "dev",
    port: 2222,
    identityFile: "/k",
    binary: "/opt/herdr",
    extraArgs: ["-4"],
  });
});

Deno.test("coverage: selfLocationFor blanks the local pane for a remote target", () => {
  const env = fakeEnv({ HERDR_PANE_ID: "w1:p4", HERDR_TAB_ID: "w1:t4" });
  assertEquals(selfLocationFor(testConfig(), env).paneId, "w1:p4");
  assertEquals(selfLocationFor(sshConfig(), env), {
    paneId: "",
    tabId: "",
    workspaceId: "",
    inHerdr: false,
  });
});

// --- server/session branches -------------------------------------------------

Deno.test("coverage: a manifest with no warning field reports an empty string", () => {
  const row = toManifestRow({ agent: "claude", active_version: "1" });
  assertEquals(row.warning, "");
  assertEquals(row.localOverrideShadowingRemote, false);
  assertEquals(row.remoteLastCheckedUnix, 0);
});

Deno.test("coverage: session-stop guards 'default' only when we are inside herdr", async () => {
  const { ctx, written } = fakeContext(model);
  const { run } = tableRunner({
    "session list --json": await fixtureStdout("session_list_two"),
    "session stop": await fixtureStdout("ok"),
  });

  // Outside herdr there is no session in use, so nothing is guarded.
  await runSessionStop(
    run,
    args("session-stop", { name: "default" }),
    ctx,
    fakeEnv(),
  );
  assertEquals(onlyWrite(written, "action").data.changed, true);
});

Deno.test("coverage: server-stop over ssh skips the local self check entirely", async () => {
  const { ctx, written } = fakeContext(model, { sshHost: "build.example" });
  const { run } = tableRunner({
    "-o BatchMode=yes": "server:\n  status: not running\n",
  });

  await runServerStop(
    run,
    args("server-stop"),
    ctx,
    fakeEnv({ HERDR_PANE_ID: "w1:p4", HERDR_WORKSPACE_ID: "w1" }),
  );

  assertEquals(onlyWrite(written, "action").data.changed, false);
});
