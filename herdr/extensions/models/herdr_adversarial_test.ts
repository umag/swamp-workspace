/**
 * ADVERSARIAL suite for @magistr/herdr.
 *
 * Assumes the herdr binary, its output, and the caller's arguments are all
 * hostile. Seven dimensions:
 *
 *   argv injection      a target or key that would be read as a flag
 *   shell injection     text carrying `;`, backticks, `$()`, newlines
 *   response integrity  arrays, strings, nulls and `__proto__` where an
 *                       object was promised
 *   resource bounds     an unbounded pane capture
 *   liveness            a herdr that never returns
 *   credential leakage  what the subprocess environment carries
 *   state integrity     no misleading data written on a failed run
 */

import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import { z } from "npm:zod@4";
import {
  assertEnvPairs,
  assertTarget,
  boundText,
  buildInvocation,
  extractEnvelope,
  herdrEnv,
  HerdrError,
  herdrJson,
  parseEnvelope,
  parseStatusBlocks,
  shellQuote,
} from "./lib/cli.ts";
import {
  model,
  runClose,
  runCreateWorkspace,
  runPrompt,
  runRead,
  runSendKeys,
  runSendText,
  runServerStop,
  runSnapshot,
  runSplitPane,
  sanitizeInstance,
} from "./herdr.ts";
import {
  argvLines,
  errorEnvelope,
  fakeContext,
  fakeEnv,
  fixtureStdout,
  onlyWrite,
  type ScriptedReply,
  scriptedRunner,
  sshConfig,
  statusFixture,
  tableRunner,
  testConfig,
} from "./lib/test_support.ts";

function args<T>(method: string, raw: Record<string, unknown> = {}): T {
  const methods = model.methods as Record<string, { arguments: z.ZodTypeAny }>;
  return methods[method].arguments.parse(raw) as T;
}

const CFG = testConfig();

// --- argv injection ----------------------------------------------------------

Deno.test("adversarial: a target starting with - is refused, not passed as a flag", async () => {
  const { ctx } = fakeContext(model);
  const { run, calls } = tableRunner({});

  for (const target of ["--help", "-f", "--takeover"]) {
    const err = await assertRejects(
      () => runRead(run, args("read", { target }), ctx),
      HerdrError,
    );
    assertEquals(err.code, "invalid_argument");
  }
  assertEquals(calls.length, 0);
});

Deno.test("adversarial: a flag-shaped key never reaches send-keys", async () => {
  const { ctx, written } = fakeContext(model);
  const { run, calls } = tableRunner({ "pane send-keys": undefined });

  const err = await assertRejects(
    () =>
      runSendKeys(
        run,
        args("send-keys", { targets: ["w1:p5"], keys: ["--takeover"] }),
        ctx,
      ),
    HerdrError,
  );
  assertEquals(err.code, "invalid_argument");
  // Keys are validated before the fan-out starts, so nothing was sent.
  assertEquals(calls.length, 0);
  assertEquals(written.length, 0);
});

Deno.test("adversarial: an env entry without = is refused before any container is made", async () => {
  const { ctx } = fakeContext(model);
  const { run, calls } = tableRunner({});

  const err = await assertRejects(
    () =>
      runCreateWorkspace(
        run,
        args("create-workspace", { label: "x", env: ["--focus"] }),
        ctx,
      ),
    HerdrError,
  );
  assertEquals(err.code, "invalid_argument");
  assertEquals(calls.length, 0);

  // A leading `=` is equally unusable: the key would be empty.
  assertThrowsHerdrSync(() => assertEnvPairs(["=value"]));
  assertEnvPairs(["A=", "A=b=c"]); // legal: empty value, and = inside a value
});

Deno.test("adversarial: a self id padded with whitespace still trips the self guard", async () => {
  const { ctx, written } = fakeContext(model);
  const { run, calls } = tableRunner({});

  const err = await assertRejects(
    () =>
      runClose(
        run,
        args("close", { container: "pane", id: "  w1:p5  " }),
        ctx,
        fakeEnv({ HERDR_PANE_ID: "w1:p5" }),
      ),
    HerdrError,
  );
  assertEquals(err.code, "self_close_refused");
  assertEquals(calls.length, 0);
  assertEquals(written.length, 0);
});

Deno.test("adversarial: assertTarget rejects empty and whitespace-only ids", () => {
  for (const bad of ["", "   ", "\t\n"]) {
    assertThrowsHerdrSync(() => assertTarget(bad));
  }
  assertEquals(assertTarget("  w1:p5 "), "w1:p5");
});

// --- shell injection ---------------------------------------------------------

Deno.test("adversarial: shell metacharacters travel as one literal argv element", async () => {
  const { ctx } = fakeContext(model);
  const hostile = "; rm -rf / & $(whoami) `id` | tee /tmp/x\nsecond line";
  const { run, calls } = tableRunner({ "pane send-text": undefined });

  await runSendText(
    run,
    args("send-text", { targets: ["w1:p5"], text: hostile }),
    ctx,
  );

  // No shell is involved: the whole payload is argv[3], byte for byte.
  assertEquals(calls[0].args.length, 4);
  assertEquals(calls[0].args[3], hostile);
});

Deno.test("adversarial: a label full of metacharacters is passed through, not expanded", async () => {
  const { ctx } = fakeContext(model);
  const label = "$(id);`whoami`";
  const { run, calls } = tableRunner({
    "workspace list": await fixtureStdout("workspace_list"),
    "workspace create": await fixtureStdout("workspace_created"),
  });

  await runCreateWorkspace(run, args("create-workspace", { label }), ctx);

  assertEquals(calls[1].args, [
    "workspace",
    "create",
    "--label",
    label,
    "--no-focus",
  ]);
});

// --- response integrity ------------------------------------------------------

Deno.test("adversarial: a non-object JSON result is refused", () => {
  for (
    const stdout of [
      '{"id":"x","result":[1,2,3]}',
      '{"id":"x","result":"nope"}',
      '{"id":"x","result":null}',
      '{"id":"x"}',
    ]
  ) {
    const err = assertThrowsHerdrSync(() =>
      parseEnvelope(["pane", "get"], { code: 0, stdout, stderr: "" })
    );
    assertEquals(err.code, "unparsable_response");
  }
});

Deno.test("adversarial: a top-level JSON array is not mistaken for an envelope", () => {
  assertEquals(extractEnvelope("[1,2,3]"), null);
  assertEquals(extractEnvelope('"a string"'), null);
  assertEquals(extractEnvelope("42"), null);
  assertEquals(extractEnvelope("{not json"), null);
  assertEquals(extractEnvelope('{"a":1} trailing garbage'), null);
});

Deno.test("adversarial: __proto__ in a response never pollutes Object.prototype", async () => {
  const { ctx, written } = fakeContext(model);
  const poisoned = JSON.stringify({
    id: "x",
    result: {
      type: "session_snapshot",
      snapshot: {
        version: "0.8.0",
        protocol: 19,
        workspaces: [{
          workspace_id: "w1",
          label: "a",
          __proto__: { pwned: 1 },
        }],
        tabs: [],
        panes: [],
        agents: [],
        layouts: [],
      },
    },
  });
  const { run } = tableRunner({ "api snapshot": `${poisoned}\n` });

  await runSnapshot(run, args("snapshot"), ctx);

  assertEquals(
    (Object.prototype as Record<string, unknown>).pwned,
    undefined,
  );
  assertEquals(onlyWrite(written, "fleet").data.workspaceCount, 1);
});

Deno.test("adversarial: wrongly-typed snapshot collections degrade to empty, not crash", async () => {
  const { ctx, written } = fakeContext(model);
  const malformed = JSON.stringify({
    id: "x",
    result: {
      type: "session_snapshot",
      snapshot: {
        version: 19,
        protocol: "nineteen",
        workspaces: "not-an-array",
        tabs: null,
        panes: { nope: true },
        agents: 5,
        focused_pane_id: 12,
      },
    },
  });
  const { run } = tableRunner({ "api snapshot": `${malformed}\n` });

  await runSnapshot(run, args("snapshot"), ctx);

  const fleet = onlyWrite(written, "fleet").data;
  // Every field still satisfies the declared schema — no undefined leaks.
  assertEquals(fleet.version, "");
  assertEquals(fleet.protocol, 0);
  assertEquals(fleet.focusedPaneId, "");
  assertEquals(fleet.workspaceCount, 0);
  assertEquals(fleet.agentCount, 0);
  assertEquals(model.resources.fleet.schema.safeParse(fleet).success, true);
});

Deno.test("adversarial: an agent row missing every optional field still validates", async () => {
  const { ctx, written } = fakeContext(model);
  const sparse = JSON.stringify({
    id: "x",
    result: {
      type: "session_snapshot",
      snapshot: {
        version: "0.8.0",
        protocol: 19,
        workspaces: [{ workspace_id: "w1", label: "a" }],
        tabs: [],
        panes: [],
        layouts: [],
        agents: [{ pane_id: "w1:p1", workspace_id: "w1" }],
      },
    },
  });
  const { run } = tableRunner({ "api snapshot": `${sparse}\n` });

  await runSnapshot(run, args("snapshot"), ctx);

  const agent = written.find((w) => w.spec === "agent")!.data;
  assertEquals(agent.status, "unknown");
  assertEquals(agent.agent, "");
  assertEquals(agent.focused, false);
  assertEquals(agent.revision, 0);
  assertEquals(model.resources.agent.schema.safeParse(agent).success, true);
});

Deno.test("adversarial: a non-string error code falls back to a generic one", () => {
  const err = assertThrowsHerdrSync(() =>
    parseEnvelope(["x"], {
      code: 1,
      stdout: '{"error":{"code":42,"message":{"nested":true}}}',
      stderr: "",
    })
  );
  assertEquals(err.code, "herdr_error");
  assert(err.message.length > 0);
});

Deno.test("adversarial: a status block with no sections yields empty fields, not throws", () => {
  assertEquals(parseStatusBlocks(""), {});
  assertEquals(parseStatusBlocks("garbage with no colon\n"), {});
  // An indented line before any section header has no owner and is dropped.
  assertEquals(parseStatusBlocks("  orphan: 1\n"), {});
});

// --- resource bounds ---------------------------------------------------------

Deno.test("adversarial: an 8MB pane capture is bounded to maxOutputBytes", async () => {
  const { ctx, written } = fakeContext(model, { maxOutputBytes: 4096 });
  const flood = "A".repeat(8 * 1024 * 1024);
  const { run } = tableRunner({
    "pane get w1:p5": await fixtureStdout("pane_info"),
    "pane read w1:p5": flood,
  });

  await runRead(run, args("read", { target: "w1:p5" }), ctx);

  const out = onlyWrite(written, "output").data;
  assertEquals(String(out.text).length, 4096);
  assertEquals(out.bytes, 8 * 1024 * 1024);
  assertEquals(out.truncated, true);
});

Deno.test("adversarial: bounding never emits a replacement character mid-glyph", () => {
  // Every cut point of a 4-byte emoji must produce valid text.
  const text = "🐑🐑🐑";
  for (let max = 1; max <= 12; max++) {
    const bounded = boundText(text, max);
    assert(
      !bounded.text.includes("�"),
      `cut at ${max} produced U+FFFD: ${JSON.stringify(bounded.text)}`,
    );
    assert(new TextEncoder().encode(bounded.text).length <= max);
  }
});

// --- liveness ----------------------------------------------------------------

Deno.test("adversarial: a herdr that never returns fails as a timeout", async () => {
  const { run } = scriptedRunner(() => ({
    code: 143,
    stdout: "",
    stderr: "",
    timedOut: true,
  }));
  const err = await assertRejects(
    () => herdrJson(run, CFG, ["api", "snapshot"]),
    HerdrError,
  );
  assertEquals(err.code, "timeout");
  assert(err.message.includes("api snapshot"), err.message);
});

Deno.test("adversarial: a wait longer than the transport cap does not get cut short", async () => {
  const { ctx } = fakeContext(model, { timeoutMs: 5_000 });
  const { run, calls } = tableRunner({
    "agent list": await fixtureStdout("agent_list"),
    "agent prompt": await fixtureStdout("agent_prompted"),
  });

  await runPrompt(
    run,
    args("prompt", {
      targets: ["w1:p5"],
      text: "go",
      wait: true,
      timeoutMs: 900_000,
    }),
    ctx,
    fakeEnv(),
  );

  // The global 5s cap must not kill a 15-minute wait the user asked for.
  assertEquals(calls[1].opts?.timeoutMs, 905_000);
});

// --- credential leakage ------------------------------------------------------

Deno.test("adversarial: an empty session is not exported as an empty variable", () => {
  assertEquals(herdrEnv(CFG), undefined);
  assertEquals(herdrEnv({ ...CFG, session: "work" }), {
    HERDR_SESSION: "work",
  });
  assertEquals(herdrEnv({ ...CFG, socketPath: "/tmp/h.sock" }), {
    HERDR_SOCKET_PATH: "/tmp/h.sock",
  });
});

Deno.test("adversarial: only herdr's own variables are added to the subprocess env", async () => {
  const { ctx } = fakeContext(model, { session: "work", socketPath: "/tmp/h" });
  const { run, calls } = tableRunner({
    "api snapshot": await fixtureStdout("api_snapshot"),
  });

  await runSnapshot(run, args("snapshot"), ctx);

  assertEquals(Object.keys(calls[0].opts?.env ?? {}).sort(), [
    "HERDR_SESSION",
    "HERDR_SOCKET_PATH",
  ]);
});

// --- state integrity ---------------------------------------------------------

Deno.test("adversarial: a duplicated target is acted on exactly once", async () => {
  const { ctx, written } = fakeContext(model);
  const { run, calls } = tableRunner({ "pane send-text": undefined });

  // The same pane spelled three ways — a caller looping over a snapshot can
  // easily produce this, and typing the text three times would corrupt input.
  await runSendText(
    run,
    args("send-text", {
      targets: ["w1:p5", " w1:p5 ", "w1:p5"],
      text: "x",
    }),
    ctx,
  );

  assertEquals(calls.length, 1);
  assertEquals(onlyWrite(written, "action").data.targetCount, 1);
});

Deno.test("adversarial: a run where every target failed writes no action resource", async () => {
  const { ctx, written } = fakeContext(model);
  const { run } = tableRunner({
    "pane send-keys": errorEnvelope("pane_not_found", "gone"),
  });

  const err = await assertRejects(
    () =>
      runSendKeys(
        run,
        args("send-keys", { targets: ["w1:p5", "w1:p6"], keys: ["enter"] }),
        ctx,
      ),
    HerdrError,
  );
  assertEquals(err.code, "all_targets_failed");
  assert(err.message.includes("w1:p5"), err.message);
  assertEquals(written.length, 0);
});

Deno.test("adversarial: a failed split writes nothing at all", async () => {
  const { ctx, written } = fakeContext(model);
  const { run } = tableRunner({
    "pane get w1:p5": await fixtureStdout("pane_info"),
    "pane split": errorEnvelope("pane_busy", "cannot split"),
  });

  await assertRejects(
    () => runSplitPane(run, args("split-pane", { pane: "w1:p5" }), ctx),
    HerdrError,
  );
  assertEquals(written.length, 0);
});

Deno.test("adversarial: a traversal-shaped id cannot escape the data directory", () => {
  assertEquals(sanitizeInstance("../../etc/passwd"), "..-..-etc-passwd");
  assertEquals(sanitizeInstance("/absolute/path"), "absolute-path");
  assertEquals(sanitizeInstance("w1:p4"), "w1-p4");
  assertEquals(sanitizeInstance(""), "unnamed");
  assertEquals(sanitizeInstance("///"), "unnamed");
  // Whatever comes in, no path separator survives.
  for (const evil of ["a/b", "a\\b", "a b", "..", "x".repeat(500)]) {
    const out = sanitizeInstance(evil);
    assert(!out.includes("/"), out);
    assert(!out.includes("\\"), out);
    assert(out.length <= 80, out);
    assert(out.length > 0, out);
  }
});

Deno.test("adversarial: a hostile pane list cannot make close skip its guard", async () => {
  const { ctx, written } = fakeContext(model);
  // herdr claims the pane is gone; the caller says missingOk=false.
  const { run } = tableRunner({
    "pane list": '{"id":"x","result":{"panes":[]}}',
  });

  const err = await assertRejects(
    () =>
      runClose(
        run,
        args("close", { container: "pane", id: "w1:p5", missingOk: false }),
        ctx,
        fakeEnv(),
      ),
    HerdrError,
  );
  assertEquals(err.code, "pane_not_found");
  assertEquals(written.length, 0);
});

Deno.test("adversarial: argv is never assembled by string concatenation", async () => {
  const { ctx } = fakeContext(model);
  const { run, calls } = tableRunner({
    "agent list": await fixtureStdout("agent_list"),
    "agent prompt": await fixtureStdout("agent_prompted"),
  });

  await runPrompt(
    run,
    args("prompt", {
      targets: ["w1:p5"],
      text: "--wait --until idle",
    }),
    ctx,
    fakeEnv(),
  );

  // The prompt text LOOKS like flags; it must stay a single argv element and
  // must not add a real --wait to the command.
  const argv = calls[1].args;
  assertEquals(argv, ["agent", "prompt", "w1:p5", "--wait --until idle"]);
  assert(!argvLines(calls)[1].endsWith(" --wait"));
});

function assertThrowsHerdrSync(fn: () => unknown): HerdrError {
  try {
    fn();
  } catch (err) {
    assert(err instanceof HerdrError, `expected HerdrError, got ${err}`);
    return err;
  }
  throw new Error("expected a HerdrError to be thrown");
}

// --- ssh transport: the shell is back, so quoting is load-bearing ------------

Deno.test("adversarial: a prompt cannot break out of the remote shell command", async () => {
  const { ctx } = fakeContext(model, { sshHost: "build.example" });
  // Classic breakout attempts against a naively-built remote command.
  const payloads = [
    "'; rm -rf / #",
    "$(id)",
    "`whoami`",
    "hello'; touch /tmp/pwned; echo '",
    "a\nrm -rf /\n",
    "'\"'\"'",
  ];

  for (const text of payloads) {
    const { run, calls } = tableRunner({ "-o BatchMode=yes": undefined });
    await runSendText(
      run,
      args("send-text", { targets: ["w1:p5"], text }),
      ctx,
    );

    const remote = calls[0].args.at(-1) as string;
    // The command is a fixed quoted prefix plus exactly one quoted payload
    // word. Slice on the KNOWN prefix rather than on the last `" '"` in the
    // string — an escaped payload legitimately contains `" '"` itself.
    const prefix = "'herdr' 'pane' 'send-text' 'w1:p5' ";
    assertEquals(remote.startsWith(prefix), true);
    assertEquals(remote.endsWith("'"), true);
    // Decoding the quoting must give the payload back byte for byte.
    assertEquals(unquote(remote.slice(prefix.length)), text);
  }
});

Deno.test("adversarial: shellQuote survives every embedded quote arrangement", () => {
  for (
    const value of [
      "",
      "'",
      "''",
      "a'b",
      "'leading",
      "trailing'",
      "$(id)",
      "a b\tc\nd",
      "\\",
      "'; echo hi; '",
    ]
  ) {
    const quoted = shellQuote(value);
    assertEquals(quoted.startsWith("'"), true);
    assertEquals(quoted.endsWith("'"), true);
    assertEquals(unquote(quoted), value);
  }
});

Deno.test("adversarial: an ssh target that looks like a flag is refused", () => {
  for (const host of ["-oProxyCommand=touch /tmp/x", "-l", "--"]) {
    const err = assertThrowsHerdrSync(() =>
      buildInvocation(sshConfig({ host }), ["status"])
    );
    assertEquals(err.code, "invalid_argument");
  }
  // A user whose name starts with "-" produces the same flag-shaped target.
  assertThrowsHerdrSync(() =>
    buildInvocation(sshConfig({ host: "h", user: "-oProxyCommand=x" }), ["x"])
  );
});

Deno.test("adversarial: the self guard never fires against a remote fleet", async () => {
  // The local pane is w1:p4. A REMOTE herdr can have a pane with the very
  // same id — closing or prompting it must not be mistaken for suicide.
  const localEnv = fakeEnv({
    HERDR_PANE_ID: "w1:p4",
    HERDR_TAB_ID: "w1:t4",
    HERDR_WORKSPACE_ID: "w1",
  });

  const closeCtx = fakeContext(model, { sshHost: "build.example" });
  const { run } = tableRunner({
    "-o BatchMode=yes": await fixtureStdout("pane_list"),
  });
  // pane_list has no w1:p4, so this lands on the missing-id no-op path —
  // what matters is that it was NOT refused as a self-close.
  await runClose(
    run,
    args("close", { container: "pane", id: "w1:p4" }),
    closeCtx.ctx,
    localEnv,
  );
  assertEquals(onlyWrite(closeCtx.written, "action").data.okCount, 1);

  // And a remote prompt to the same id is sent, not skipped.
  const promptCtx = fakeContext(model, { sshHost: "build.example" });
  const promptRun = scriptedRunner((argv): ScriptedReply => {
    const remote = argv.at(-1) as string;
    if (remote.includes("'agent' 'list'")) {
      return `${
        JSON.stringify({
          id: "x",
          result: {
            agents: [{
              pane_id: "w1:p4",
              workspace_id: "w1",
              tab_id: "w1:t4",
              agent_status: "idle",
              focused: false,
              revision: 1,
            }],
          },
        })
      }\n`;
    }
    return `${
      JSON.stringify({
        id: "x",
        result: {
          agent: {
            pane_id: "w1:p4",
            workspace_id: "w1",
            tab_id: "w1:t4",
            agent_status: "working",
            focused: false,
            revision: 1,
          },
        },
      })
    }\n`;
  });
  await runPrompt(
    promptRun.run,
    args("prompt", { targets: ["w1:p4"], text: "go" }),
    promptCtx.ctx,
    localEnv,
  );
  const action = onlyWrite(promptCtx.written, "action").data;
  assertEquals(action.changedCount, 1);
  assertEquals(action.skippedCount, 0);
});

Deno.test("adversarial: the local self guard still fires when no ssh host is set", async () => {
  const { ctx } = fakeContext(model);
  const { run } = tableRunner({});

  const err = await assertRejects(
    () =>
      runClose(
        run,
        args("close", { container: "pane", id: "w1:p4" }),
        ctx,
        fakeEnv({ HERDR_PANE_ID: "w1:p4" }),
      ),
    HerdrError,
  );
  assertEquals(err.code, "self_close_refused");
});

Deno.test("adversarial: server-stop over ssh is not blocked by the local pane", async () => {
  // Stopping a REMOTE server cannot kill the terminal running this method.
  const { ctx, written } = fakeContext(model, { sshHost: "build.example" });
  const { run } = tableRunner({ "-o BatchMode=yes": await statusFixture() });

  await runServerStop(
    run,
    args("server-stop"),
    ctx,
    fakeEnv({ HERDR_PANE_ID: "w1:p4" }),
  );

  assertEquals(onlyWrite(written, "action").data.changed, true);
});

Deno.test("adversarial: caller ssh options are placed where they win", () => {
  const invocation = buildInvocation(
    sshConfig({ extraArgs: ["-o", "BatchMode=no", "-o", "ConnectTimeout=60"] }),
    ["status"],
  );
  // ssh keeps the FIRST value obtained for an option, so the caller's copies
  // must precede the defaults or the defaults would silently win instead.
  assertEquals(invocation.args.slice(0, 4), [
    "-o",
    "BatchMode=no",
    "-o",
    "ConnectTimeout=60",
  ]);
  assertEquals(
    invocation.args.indexOf("BatchMode=no") <
      invocation.args.indexOf("BatchMode=yes"),
    true,
  );
});

Deno.test("adversarial: a remote binary path with spaces stays one word", () => {
  const invocation = buildInvocation(
    sshConfig({ binary: "/opt/my herdr/bin/herdr" }),
    ["status"],
  );
  assertEquals(
    invocation.args.at(-1),
    "'/opt/my herdr/bin/herdr' 'status'",
  );
});

/** Decode one fully single-quoted POSIX word — an oracle independent of shellQuote. */
function unquote(quoted: string): string {
  let out = "";
  let i = 0;
  while (i < quoted.length) {
    if (quoted[i] !== "'") throw new Error(`expected ' at ${i}: ${quoted}`);
    i++;
    while (i < quoted.length && quoted[i] !== "'") out += quoted[i++];
    if (i >= quoted.length) throw new Error(`unterminated quote: ${quoted}`);
    i++; // closing quote
    // A literal quote is spelled \' between two quoted runs.
    if (quoted.slice(i, i + 2) === "\\'") {
      out += "'";
      i += 2;
    }
  }
  return out;
}
