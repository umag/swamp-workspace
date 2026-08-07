/**
 * PROPERTY / INVARIANT / FLOW suite for @magistr/herdr (fast-check).
 *
 * Properties:
 *  (a) dedupeTargets — output is duplicate-free, order-preserving, and a
 *      subset of the trimmed non-empty inputs, for any target list.
 *  (b) boundText — the capture is always a prefix of the input, never
 *      exceeds the byte cap, and always reports the input's TRUE byte
 *      length, across the full cut range of arbitrary Unicode (including
 *      astral planes, where a naive byte slice splits a code point).
 *  (c) fan-out accounting — for any random mix of success / failure / self-
 *      skip, the action resource satisfies ok + failed == targets and
 *      changed + skipped == ok, and exactly the non-skipped targets are
 *      invoked.
 *  (d) argv structure — caller-supplied data (labels, prompts, commands)
 *      always lands as exactly one argv element and never adds a flag,
 *      however flag-shaped that data looks.
 *  (e) snapshot accounting — the fleet's per-status histogram always sums to
 *      agentCount, and filtering by workspace never yields an agent from
 *      another workspace, over randomly generated sessions.
 *  (f) remote quoting — every argument of an ssh-transported command comes
 *      back out of a REAL POSIX shell byte for byte, so no prompt, label or
 *      command can break out into the remote host's shell.
 *
 * PLUS an explicit multi-step FLOW: create-workspace → create-tab →
 * split-pane → close, asserting the idempotency contract end to end (a
 * repeated create is a reuse; a repeated close is a no-op).
 *
 * The oracles here are computed independently of the implementation — the
 * byte-length oracle uses its own TextEncoder pass, the accounting oracles
 * count the generated plan rather than the model's own counters, and the
 * quoting oracle is `/bin/sh` itself (the only place in this extension's
 * suites that spawns anything; it never runs herdr or opens a socket).
 *
 * fast-check pinned: `npm:fast-check@4.8.0`. Iteration count gated by
 * FC_NUM_RUNS (small default in CI, large in `deno task test:soak`).
 */

import { assert, assertEquals } from "jsr:@std/assert@1";
import fc from "npm:fast-check@4.8.0";
import { z } from "npm:zod@4";
import { boundText, HerdrError, remoteCommand, shellQuote } from "./lib/cli.ts";
import {
  dedupeTargets,
  model,
  runClose,
  runCreateTab,
  runCreateWorkspace,
  runPrompt,
  runSendText,
  runSnapshot,
  runSplitPane,
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
  tableRunner,
} from "./lib/test_support.ts";

const ENV_RUNS = Deno.env.get("FC_NUM_RUNS");
const NIGHT = (n: number): number => (ENV_RUNS ? Number(ENV_RUNS) : n);
const FC_RUNS = { numRuns: NIGHT(50) };

function args<T>(method: string, raw: Record<string, unknown> = {}): T {
  const methods = model.methods as Record<string, { arguments: z.ZodTypeAny }>;
  return methods[method].arguments.parse(raw) as T;
}

// --- (a) dedupeTargets -------------------------------------------------------

Deno.test("property: dedupeTargets is order-preserving, blank-free and idempotent", () => {
  fc.assert(
    fc.property(fc.array(fc.string(), { maxLength: 40 }), (raw) => {
      const out = dedupeTargets(raw);

      // Oracle built from the input, not from the implementation.
      const expected: string[] = [];
      const seen = new Set<string>();
      for (const s of raw) {
        const t = s.trim();
        if (!t || seen.has(t)) continue;
        seen.add(t);
        expected.push(t);
      }
      assertEquals(out, expected);

      assertEquals(new Set(out).size, out.length);
      assert(out.every((t) => t.length > 0 && t === t.trim()));
      // Running it again changes nothing.
      assertEquals(dedupeTargets(out), out);
    }),
    FC_RUNS,
  );
});

// --- (b) boundText -----------------------------------------------------------

Deno.test("property: boundText yields a prefix within the cap and reports true size", () => {
  const encoder = new TextEncoder();
  fc.assert(
    fc.property(
      fc.string({ unit: "binary", maxLength: 60 }),
      fc.integer({ min: 1, max: 200 }),
      (text, maxBytes) => {
        const bounded = boundText(text, maxBytes);

        // Independent oracle for the reported size.
        assertEquals(bounded.bytes, encoder.encode(text).length);

        // Never over the cap.
        assert(
          encoder.encode(bounded.text).length <= maxBytes,
          `over cap: ${encoder.encode(bounded.text).length} > ${maxBytes}`,
        );

        // Always a prefix of the input — a mid-code-point cut must shrink,
        // never substitute.
        assert(
          text.startsWith(bounded.text),
          `not a prefix: ${JSON.stringify(bounded.text)}`,
        );

        // truncated is exactly "we dropped something".
        assertEquals(bounded.truncated, bounded.text.length < text.length);
      },
    ),
    FC_RUNS,
  );
});

Deno.test("property: astral code points are never split into replacement chars", () => {
  const encoder = new TextEncoder();
  fc.assert(
    fc.property(
      fc.array(fc.constantFrom("🐑", "é", "字", "a"), { maxLength: 20 }),
      fc.integer({ min: 1, max: 90 }),
      (parts, maxBytes) => {
        const text = parts.join("");
        const bounded = boundText(text, maxBytes);
        // U+FFFD can only appear in the output if the input had one.
        assertEquals(
          bounded.text.includes("�"),
          text.includes("�"),
        );
        assert(encoder.encode(bounded.text).length <= maxBytes);
      },
    ),
    FC_RUNS,
  );
});

// --- (c) fan-out accounting --------------------------------------------------

type Fate = "ok" | "fail" | "self";

Deno.test("property: fan-out accounting always balances", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.array(fc.constantFrom<Fate>("ok", "fail", "self"), {
        minLength: 1,
        maxLength: 12,
      }),
      async (fates) => {
        // One pane per fate; the "self" pane is the one the method runs in.
        // Only ONE pane can be the caller, so any further "self" draws are
        // ordinary targets — the effective plan, not the raw draw, is the
        // oracle.
        const panes = fates.map((_, i) => `w1:p${i}`);
        const selfIndex = fates.indexOf("self");
        const selfPane = selfIndex >= 0 ? panes[selfIndex] : "";
        const effective: Fate[] = fates.map((f, i) =>
          f === "self" && i !== selfIndex ? "ok" : f
        );

        const agentList = JSON.stringify({
          id: "x",
          result: {
            agents: panes.map((pane_id) => ({
              pane_id,
              workspace_id: "w1",
              tab_id: "w1:t1",
              agent: "claude",
              agent_status: "idle",
              focused: false,
              revision: 1,
            })),
          },
        });

        const { run, calls } = scriptedRunner((argv): ScriptedReply => {
          if (argv[0] === "agent" && argv[1] === "list") {
            return `${agentList}\n`;
          }
          const target = argv[2];
          const fate = effective[panes.indexOf(target)];
          if (fate === "fail") return errorEnvelope("agent_busy", "busy");
          return JSON.stringify({
            id: "x",
            result: {
              agent: {
                pane_id: target,
                workspace_id: "w1",
                tab_id: "w1:t1",
                agent_status: "working",
                focused: false,
                revision: 1,
              },
            },
          });
        });

        // Oracle: counted from the generated plan, not from the model.
        const skipped = effective.filter((f) => f === "self").length;
        const failed = effective.filter((f) => f === "fail").length;
        const changed = effective.filter((f) => f === "ok").length;
        const total = effective.length;

        const { ctx, written } = fakeContext(model);
        let threw = false;
        try {
          await runPrompt(
            run,
            args("prompt", { targets: panes, text: "go" }),
            ctx,
            fakeEnv(selfPane ? { HERDR_PANE_ID: selfPane } : {}),
          );
        } catch (err) {
          assert(err instanceof HerdrError);
          assertEquals(err.code, "all_targets_failed");
          threw = true;
        }

        if (threw) {
          // Only legal when nothing succeeded, and nothing may be written.
          assertEquals(changed + skipped, 0);
          assertEquals(written.length, 0);
          return;
        }

        const action = onlyWrite(written, "action").data;
        assertEquals(action.targetCount, total);
        assertEquals(action.okCount, changed + skipped);
        assertEquals(action.failedCount, failed);
        assertEquals(action.changedCount, changed);
        assertEquals(action.skippedCount, skipped);
        assertEquals(
          Number(action.okCount) + Number(action.failedCount),
          total,
        );
        assertEquals(
          Number(action.changedCount) + Number(action.skippedCount),
          Number(action.okCount),
        );
        assertEquals((action.results as unknown[]).length, total);

        // Exactly the non-skipped targets were invoked (plus one agent list).
        assertEquals(calls.length, 1 + (total - skipped));
      },
    ),
    FC_RUNS,
  );
});

// --- (d) argv structure ------------------------------------------------------

Deno.test("property: caller data lands as one argv element and adds no flag", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.string({ maxLength: 60 }).filter((s) => s.trim().length > 0),
      async (payload) => {
        const { ctx } = fakeContext(model);
        const { run, calls } = tableRunner({ "pane send-text": undefined });

        await runSendText(
          run,
          args("send-text", { targets: ["w1:p5"], text: payload }),
          ctx,
        );

        const argv = calls[0].args;
        // Fixed shape: pane send-text <target> <text>. However flag-shaped
        // the payload is, it can only ever occupy the last slot.
        assertEquals(argv.length, 4);
        assertEquals(argv.slice(0, 3), ["pane", "send-text", "w1:p5"]);
        assertEquals(argv[3], payload);
      },
    ),
    FC_RUNS,
  );
});

Deno.test("property: a workspace label is always the value of --label, never a flag", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.string({ maxLength: 40 }).filter((s) => s.length > 0),
      async (label) => {
        const { ctx } = fakeContext(model);
        const { run, calls } = tableRunner({
          "workspace list": '{"id":"x","result":{"workspaces":[]}}',
          "workspace create": await fixtureStdout("workspace_created"),
        });

        await runCreateWorkspace(run, args("create-workspace", { label }), ctx);

        const argv = calls[1].args;
        const at = argv.indexOf("--label");
        assertEquals(argv[at + 1], label);
        // The only flags present are the ones the method itself added.
        assertEquals(argv.length, 5);
        assertEquals(argv[4], "--no-focus");
      },
    ),
    FC_RUNS,
  );
});

// --- (e) snapshot accounting -------------------------------------------------

const STATUSES = ["idle", "working", "blocked", "done", "unknown"] as const;

Deno.test("property: the fleet histogram sums to agentCount and respects the filter", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.array(
        fc.record({
          workspace: fc.constantFrom("w1", "w2", "w3"),
          status: fc.constantFrom(...STATUSES),
        }),
        { maxLength: 25 },
      ),
      fc.option(fc.constantFrom("w1", "w2", "w3"), { nil: "" }),
      async (rows, filter) => {
        const workspaceIds = ["w1", "w2", "w3"];
        const snapshot = {
          version: "0.8.0",
          protocol: 19,
          layouts: [],
          workspaces: workspaceIds.map((id, i) => ({
            workspace_id: id,
            label: `ws-${i}`,
            number: i + 1,
            focused: false,
            active_tab_id: `${id}:t1`,
            tab_count: 1,
            pane_count: 1,
            agent_status: "unknown",
          })),
          tabs: workspaceIds.map((id) => ({
            tab_id: `${id}:t1`,
            workspace_id: id,
            label: "1",
            number: 1,
            focused: false,
            pane_count: 1,
            agent_status: "unknown",
          })),
          panes: rows.map((r, i) => ({
            pane_id: `${r.workspace}:p${i}`,
            workspace_id: r.workspace,
            tab_id: `${r.workspace}:t1`,
            agent_status: r.status,
            focused: false,
            revision: 0,
          })),
          agents: rows.map((r, i) => ({
            pane_id: `${r.workspace}:p${i}`,
            workspace_id: r.workspace,
            tab_id: `${r.workspace}:t1`,
            agent: "claude",
            agent_status: r.status,
            focused: false,
            revision: 0,
          })),
        };

        const { ctx, written } = fakeContext(model);
        const { run } = tableRunner({
          "api snapshot": `${
            JSON.stringify({ id: "x", result: { snapshot } })
          }\n`,
        });

        await runSnapshot(
          run,
          args("snapshot", { workspace: filter, writeAgents: false }),
          ctx,
        );

        const fleet = onlyWrite(written, "fleet").data;
        const byStatus = fleet.byStatus as Record<string, number>;
        const histogramTotal = Object.values(byStatus).reduce(
          (a, b) => a + b,
          0,
        );
        assertEquals(histogramTotal, fleet.agentCount);

        // Oracle: count the generated rows, not the model's own tally.
        const expected = rows.filter((r) => !filter || r.workspace === filter);
        assertEquals(fleet.agentCount, expected.length);

        const agents = fleet.agents as Record<string, unknown>[];
        if (filter) {
          assert(agents.every((a) => a.workspaceId === filter));
          assertEquals(fleet.workspaceCount, 1);
        } else {
          assertEquals(fleet.workspaceCount, 3);
        }
        assertEquals(agents.length, expected.length);

        // The three highlighted counters agree with the histogram.
        assertEquals(fleet.busyCount, byStatus.working ?? 0);
        assertEquals(fleet.idleCount, byStatus.idle ?? 0);
        assertEquals(fleet.blockedCount, byStatus.blocked ?? 0);
      },
    ),
    FC_RUNS,
  );
});

// --- multi-step flow ---------------------------------------------------------

Deno.test("flow: create → create again → tab → split → close → close again", async () => {
  // A stateful fake herdr: just enough of the server to observe idempotency
  // across a realistic sequence of methods.
  const workspaces: Record<string, unknown>[] = [];
  const tabs: Record<string, unknown>[] = [];
  const panes: Record<string, unknown>[] = [];
  let nextWs = 1;
  let nextPane = 1;

  const { run } = scriptedRunner((argv): ScriptedReply => {
    const cmd = argv.slice(0, 2).join(" ");
    if (cmd === "workspace list") {
      return JSON.stringify({ id: "x", result: { workspaces } });
    }
    if (cmd === "tab list") {
      return JSON.stringify({ id: "x", result: { tabs } });
    }
    if (cmd === "pane list") {
      return JSON.stringify({ id: "x", result: { panes } });
    }
    if (cmd === "workspace create") {
      const id = `w${nextWs++}`;
      const label = argv[argv.indexOf("--label") + 1];
      const workspace = {
        workspace_id: id,
        label,
        number: nextWs - 1,
        focused: false,
        active_tab_id: `${id}:t1`,
        tab_count: 1,
        pane_count: 1,
        agent_status: "unknown",
      };
      const tab = {
        tab_id: `${id}:t1`,
        workspace_id: id,
        label: "1",
        number: 1,
        focused: false,
        pane_count: 1,
        agent_status: "unknown",
      };
      const pane = {
        pane_id: `${id}:p${nextPane++}`,
        workspace_id: id,
        tab_id: tab.tab_id,
        agent_status: "unknown",
        focused: false,
        revision: 0,
      };
      workspaces.push(workspace);
      tabs.push(tab);
      panes.push(pane);
      return JSON.stringify({
        id: "x",
        result: { workspace, tab, root_pane: pane },
      });
    }
    if (cmd === "tab create") {
      const ws = argv[argv.indexOf("--workspace") + 1];
      const label = argv[argv.indexOf("--label") + 1];
      const tab = {
        tab_id: `${ws}:t${tabs.length + 1}`,
        workspace_id: ws,
        label,
        number: tabs.length + 1,
        focused: false,
        pane_count: 1,
        agent_status: "unknown",
      };
      const pane = {
        pane_id: `${ws}:p${nextPane++}`,
        workspace_id: ws,
        tab_id: tab.tab_id,
        agent_status: "unknown",
        focused: false,
        revision: 0,
      };
      tabs.push(tab);
      panes.push(pane);
      return JSON.stringify({ id: "x", result: { tab, root_pane: pane } });
    }
    if (cmd === "pane get") {
      const pane = panes.find((p) => p.pane_id === argv[2]);
      if (!pane) return errorEnvelope("pane_not_found", `${argv[2]} not found`);
      return JSON.stringify({ id: "x", result: { pane } });
    }
    if (cmd === "pane split") {
      const from = panes.find((p) => p.pane_id === argv[2])!;
      const pane = {
        pane_id: `${from.workspace_id}:p${nextPane++}`,
        workspace_id: from.workspace_id,
        tab_id: from.tab_id,
        agent_status: "unknown",
        focused: false,
        revision: 0,
      };
      panes.push(pane);
      return JSON.stringify({ id: "x", result: { pane } });
    }
    if (cmd === "workspace close") {
      const at = workspaces.findIndex((w) => w.workspace_id === argv[2]);
      if (at < 0) return errorEnvelope("workspace_not_found", "gone");
      workspaces.splice(at, 1);
      return JSON.stringify({ id: "x", result: { type: "ok" } });
    }
    throw new Error(`unscripted: herdr ${argv.join(" ")}`);
  });

  const seen: string[] = [];

  // 1. create — a brand new workspace.
  {
    const { ctx, written } = fakeContext(model);
    await runCreateWorkspace(
      run,
      args("create-workspace", { label: "flow" }),
      ctx,
    );
    const c = onlyWrite(written, "container").data;
    assertEquals(c.created, true);
    seen.push(String(c.workspaceId));
  }

  // 2. create again — same label, so it must be REUSED, not duplicated.
  {
    const { ctx, written } = fakeContext(model);
    await runCreateWorkspace(
      run,
      args("create-workspace", { label: "flow" }),
      ctx,
    );
    const c = onlyWrite(written, "container").data;
    assertEquals(c.created, false);
    assertEquals(c.workspaceId, seen[0]);
  }
  assertEquals(workspaces.length, 1);

  // 3. tab, then the same tab again — same reuse contract one level down.
  {
    const { ctx, written } = fakeContext(model);
    await runCreateTab(
      run,
      args("create-tab", { workspace: seen[0], label: "work" }),
      ctx,
    );
    assertEquals(onlyWrite(written, "container").data.created, true);
  }
  {
    const { ctx, written } = fakeContext(model);
    await runCreateTab(
      run,
      args("create-tab", { workspace: seen[0], label: "work" }),
      ctx,
    );
    assertEquals(onlyWrite(written, "container").data.created, false);
  }
  assertEquals(tabs.length, 2);

  // 4. split — genuinely additive every time, by design.
  const rootPane = String(panes[0].pane_id);
  for (const _ of [0, 1]) {
    const { ctx, written } = fakeContext(model);
    await runSplitPane(run, args("split-pane", { pane: rootPane }), ctx);
    assertEquals(onlyWrite(written, "container").data.created, true);
  }
  assertEquals(panes.length, 4);

  // A create and its matching reuse must land on the SAME data instance, or
  // `data.latest` on the create's instance would never see the reuse.
  const instances: string[] = [];
  for (const _ of [0, 1]) {
    const { ctx, written } = fakeContext(model);
    await runCreateWorkspace(
      run,
      args("create-workspace", { label: "flow" }),
      ctx,
    );
    instances.push(onlyWrite(written, "container").instance);
  }
  assertEquals(instances[0], instances[1]);
  assertEquals(instances[0], `container-workspace-${seen[0]}`);

  // 5. close, then close again — the second is a no-op, not an error.
  {
    const { ctx, written } = fakeContext(model);
    await runClose(
      run,
      args("close", { container: "workspace", id: seen[0] }),
      ctx,
      fakeEnv(),
    );
    assertEquals(onlyWrite(written, "action").data.changed, true);
  }
  {
    const { ctx, written } = fakeContext(model);
    await runClose(
      run,
      args("close", { container: "workspace", id: seen[0] }),
      ctx,
      fakeEnv(),
    );
    const action = onlyWrite(written, "action").data;
    assertEquals(action.changed, false);
    assertEquals(action.okCount, 1);
  }
  assertEquals(workspaces.length, 0);
});

Deno.test("flow: a repeated create-workspace never issues a second create call", async () => {
  const { ctx } = fakeContext(model);
  const created = await fixtureStdout("workspace_created");
  let listing = '{"id":"x","result":{"workspaces":[]}}';
  const { run, calls } = scriptedRunner((argv): ScriptedReply => {
    if (argv.join(" ") === "workspace list") return listing;
    listing = JSON.stringify({
      id: "x",
      result: {
        workspaces: [{
          workspace_id: "w3",
          label: "review",
          number: 3,
          focused: false,
          active_tab_id: "w3:t1",
          tab_count: 1,
          pane_count: 1,
          agent_status: "unknown",
        }],
      },
    });
    return created;
  });

  for (const _ of [0, 1, 2, 3]) {
    await runCreateWorkspace(
      run,
      args("create-workspace", { label: "review" }),
      ctx,
    );
  }

  const creates = argvLines(calls).filter((l) =>
    l.startsWith("workspace create")
  );
  assertEquals(creates.length, 1);
});

// --- (f) remote quoting, proved against a real POSIX shell -------------------

/**
 * The strongest available oracle for shellQuote is an actual shell: build a
 * remote command exactly as the transport would, run it through `sh -c` with
 * a printf that echoes its argv, and require the arguments to come back byte
 * for byte. A hand-written decoder could share a blind spot with the encoder;
 * /bin/sh cannot.
 *
 * This is the one place in the suite that spawns a process. It never runs
 * herdr and never opens a socket — `sh` and `printf` only.
 */
async function shellRoundTrip(args: string[]): Promise<string[]> {
  // `printf '%s\0'` keeps arguments unambiguous even when they contain
  // newlines, which the payloads deliberately do.
  const command = ["printf", "'%s\\0'", ...args.map(shellQuote)].join(" ");
  const { stdout, code } = await new Deno.Command("sh", {
    args: ["-c", command],
    stdout: "piped",
    stderr: "piped",
  }).output();
  assertEquals(code, 0);
  const decoded = new TextDecoder().decode(stdout);
  const parts = decoded.split("\0");
  parts.pop(); // trailing empty piece after the final NUL
  return parts;
}

Deno.test("property: shellQuote round-trips through a real POSIX shell", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.array(
        fc.string({ unit: "grapheme", maxLength: 30 }).filter((s) =>
          // NUL cannot survive an argv round trip through any shell, and no
          // herdr argument can contain one either.
          !s.includes("\0")
        ),
        { minLength: 1, maxLength: 5 },
      ),
      async (args) => {
        assertEquals(await shellRoundTrip(args), args);
      },
    ),
    { numRuns: NIGHT(15) },
  );
});

Deno.test("property: the classic breakout payloads survive a real shell intact", async () => {
  // Fixed adversarial corpus, checked against /bin/sh rather than a model of
  // it — these are the strings a fuzzer is least likely to generate.
  const payloads = [
    "'; rm -rf / #",
    "$(id)",
    "`whoami`",
    "a'b\"c",
    "'\\''",
    "\\",
    "$HOME",
    "${IFS}",
    "a\nb\tc",
    "*",
    "~",
    "!!",
    "&& echo pwned",
    "| tee /tmp/x",
  ];
  assertEquals(await shellRoundTrip(payloads), payloads);
});

Deno.test("property: a whole remote command survives the shell as distinct argv", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.string({ maxLength: 40 }).filter((s) => !s.includes("\0")),
      async (payload) => {
        const cfg = sshConfig({}, { session: "work" });
        const remote = remoteCommand(cfg, [
          "pane",
          "send-text",
          "w1:p5",
          payload,
        ]);
        // Run the built command with `env`/herdr replaced by an argv echo, so
        // what is measured is the QUOTING, not the presence of herdr.
        const probe = remote
          .replace("'herdr'", "printf '%s\\0'")
          .replace(/^env /, "env -i ");
        const { stdout, code } = await new Deno.Command("sh", {
          args: ["-c", probe],
          stdout: "piped",
          stderr: "piped",
        }).output();
        assertEquals(code, 0);
        const parts = new TextDecoder().decode(stdout).split("\0");
        parts.pop();
        assertEquals(parts, ["pane", "send-text", "w1:p5", payload]);
      },
    ),
    { numRuns: NIGHT(15) },
  );
});
