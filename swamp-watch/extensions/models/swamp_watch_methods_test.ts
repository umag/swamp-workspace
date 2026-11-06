/**
 * methods suite for @magistr/swamp-watch — every method's success and failure
 * path, driven through `model.methods.<m>.execute()` shape via the exported
 * impls with a scripted runner and a fake context.
 */

import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import { model, runDrift, runScan } from "./swamp_watch.ts";
import {
  byWorkflow,
  fail,
  fakeContext,
  ok,
  parseExposition,
  scriptedRunner,
} from "./lib/testing.ts";
import workflowList from "../../fixtures/workflow_list.json" with {
  type: "json",
};
import historyFleet from "../../fixtures/workflow_history_fleet_health.json" with {
  type: "json",
};
import historyEmpty from "../../fixtures/workflow_history_empty.json" with {
  type: "json",
};
import scheduleList from "../../fixtures/workflow_schedule_list.json" with {
  type: "json",
};

const LIST = JSON.stringify(workflowList);
const FLEET = JSON.stringify(historyFleet);
const EMPTY = JSON.stringify(historyEmpty);
const noSleep = () => Promise.resolve();

function router(args: string[]) {
  if (args[1] === "list") return ok(LIST);
  if (args[1] === "history") {
    return args[3] === "fleet-health" ? ok(FLEET) : ok(EMPTY);
  }
  return undefined;
}

Deno.test("scan: writes one scan resource under a distinct instance name", async () => {
  const s = scriptedRunner(router);
  const ctx = fakeContext({ repoDir: "/repo", repoLabel: "serve" });
  await runScan(s.run, {}, ctx);
  assertEquals(ctx.written.length, 1);
  assertEquals(ctx.written[0].spec, "scan");
  // Must NOT be "current": drift writes too, and a shared instance name makes
  // the two methods overwrite each other's data.
  assertEquals(ctx.written[0].instance, "scan-current");
});

Deno.test("scan: reports every scheduled workflow with period and budget", async () => {
  const s = scriptedRunner(router);
  const ctx = fakeContext({ repoDir: "/repo", repoLabel: "serve" });
  const res = await runScan(s.run, {}, ctx);
  assertEquals(res.scheduledCount, 4);
  assertEquals(res.unparsedSchedules, []);
  const periods = byWorkflow(
    res.lines,
    "swamp_workflow_expected_period_seconds",
  );
  assertEquals(periods["fleet-health"], 120);
  assertEquals(periods["ext-canary-nightly"], 86400);
  // The uneven schedule: two fires a day, but a 13h worst-case gap.
  assertEquals(periods["daily-health"], 46800);
  const budgets = byWorkflow(res.lines, "swamp_workflow_stale_after_seconds");
  assertEquals(budgets["fleet-health"], 1920);
  assertEquals(budgets["daily-health"], 70200);
});

Deno.test("scan: a workflow with no observed success still gets a zero-valued series", async () => {
  const s = scriptedRunner(router);
  const ctx = fakeContext({ repoDir: "/repo", repoLabel: "serve" });
  const res = await runScan(s.run, {}, ctx);
  const last = byWorkflow(
    res.lines,
    "swamp_workflow_last_success_timestamp_seconds",
  );
  assert("ext-canary-nightly" in last);
  // Omitting the series would leave it absent, and an absent series cannot be
  // compared — the never-succeeded case would be the one that stayed silent.
  assertEquals(last["ext-canary-nightly"], 0);
  assert(last["fleet-health"] > 0);
});

Deno.test("scan: every scheduled workflow gets an observation timestamp", async () => {
  const s = scriptedRunner(router);
  const ctx = fakeContext({ repoDir: "/repo", repoLabel: "serve" });
  const res = await runScan(s.run, {}, ctx);
  const observed = byWorkflow(
    res.lines,
    "swamp_watch_observed_timestamp_seconds",
  );
  assertEquals(Object.keys(observed).sort(), [
    "daily-health",
    "eod-steward",
    "ext-canary-nightly",
    "fleet-health",
  ]);
  for (const v of Object.values(observed)) assert(v > 1_700_000_000);
});

Deno.test("scan: the repo label lands on every series", async () => {
  const s = scriptedRunner(router);
  const ctx = fakeContext({ repoDir: "/repo", repoLabel: "mac" });
  const res = await runScan(s.run, {}, ctx);
  for (const series of parseExposition(res.lines)) {
    assertEquals(series.labels.repo, "mac");
  }
});

Deno.test("scan: fails loudly when the workflow list cannot be read", async () => {
  const s = scriptedRunner((args) =>
    args[1] === "list" ? fail("boom: repo not found") : ok(EMPTY)
  );
  const ctx = fakeContext({ repoDir: "/repo" });
  await assertRejects(() => runScan(s.run, {}, ctx));
  // Nothing was written: a half-scan pushed as if complete would drop every
  // workflow's series and read as a fleet-wide recovery.
  assertEquals(ctx.written.length, 0);
});

Deno.test("drift: separates missing workflows from broken probes", async () => {
  const s = scriptedRunner((args) => {
    if (args[1] === "list") return ok(LIST);
    if (args[1] === "get") {
      if (args[2] === "ext-canary-nightly") {
        return fail(
          "Server reported workflow_get_failed: Workflow not found: ext-canary-nightly",
        );
      }
      if (args[2] === "eod-steward") return fail("Authentication failed");
      return ok(JSON.stringify({ name: args[2], version: 1 }));
    }
    return undefined;
  });
  const ctx = fakeContext({
    repoDir: "/repo",
    repoLabel: "mac",
    server: "https://serve.example",
    retryBackoffMs: 0,
  });
  const res = await runDrift(s.run, {}, ctx, noSleep);
  assertEquals(res.missing.map((m) => m.workflow), ["ext-canary-nightly"]);
  assertEquals(res.errors.map((e) => e.workflow), ["eod-steward"]);
  assertEquals(res.presentCount, 3);
  assertEquals(ctx.written[0].instance, "drift-current");
});

Deno.test("drift: emits presence as 1/0 and keeps the schedule on the missing one", async () => {
  const s = scriptedRunner((args) => {
    if (args[1] === "list") return ok(LIST);
    if (args[1] === "get") {
      return args[2] === "ext-canary-nightly"
        ? fail("Workflow not found: ext-canary-nightly")
        : ok(JSON.stringify({ name: args[2] }));
    }
    return undefined;
  });
  const ctx = fakeContext({
    repoDir: "/repo",
    repoLabel: "mac",
    server: "https://serve.example",
    retryBackoffMs: 0,
  });
  const res = await runDrift(s.run, {}, ctx, noSleep);
  const present = parseExposition(res.lines).filter((x) =>
    x.name === "swamp_workflow_present_on_server"
  );
  const canary = present.find((x) =>
    x.labels.workflow === "ext-canary-nightly"
  );
  assertEquals(canary?.value, 0);
  // The schedule rides along so the alert can say what was supposed to run.
  assertEquals(canary?.labels.schedule, "0 3 * * *");
  assertEquals(
    present.find((x) => x.labels.workflow === "fleet-health")?.value,
    1,
  );
});

Deno.test("drift: refuses to run without a server rather than reporting no drift", async () => {
  const s = scriptedRunner(() => ok(LIST));
  const ctx = fakeContext({ repoDir: "/repo", repoLabel: "mac" });
  await assertRejects(
    () => runDrift(s.run, {}, ctx, noSleep),
    Error,
    "server",
  );
});

Deno.test("model: declares both methods and both resources", () => {
  assertEquals(Object.keys(model.methods).sort(), ["drift", "scan"]);
  assertEquals(Object.keys(model.resources).sort(), ["drift", "scan"]);
  assertEquals(model.type, "@magistr/swamp-watch");
});

Deno.test("model: scan's argument schema accepts and defaults includeUnscheduled", () => {
  const parsed = model.methods.scan.arguments.parse({});
  assertEquals(parsed.includeUnscheduled, false);
  assertEquals(
    model.methods.scan.arguments.parse({ includeUnscheduled: true })
      .includeUnscheduled,
    true,
  );
});

// --- schedule pauses ----------------------------------------------------------
const SCHEDULES = JSON.stringify(scheduleList);

function pauseRouter(args: string[]) {
  if (args[1] === "schedule" && args[2] === "list") return ok(SCHEDULES);
  return router(args);
}

Deno.test("scan: a paused schedule is reported paused, every other one active", async () => {
  const s = scriptedRunner(pauseRouter);
  const ctx = fakeContext({ repoDir: "/repo", repoLabel: "serve" });
  const res = await runScan(s.run, {}, ctx);
  const paused = byWorkflow(res.lines, "swamp_workflow_paused");
  // eod-steward is paused in the real capture; the rest are not.
  assertEquals(paused["eod-steward"], 1);
  assertEquals(paused["fleet-health"], 0);
  assertEquals(paused["daily-health"], 0);
  // A workflow the schedule list does not mention is active, not paused.
  assertEquals(paused["ext-canary-nightly"], 0);
  assertEquals(res.pausedWorkflows, ["eod-steward"]);
  assertEquals(res.pauseError, null);
  const ok1 = parseExposition(res.lines).find((m) =>
    m.name === "swamp_watch_pause_read_ok"
  );
  assertEquals(ok1?.value, 1);
});

Deno.test("scan: a paused workflow keeps every other series, so resuming it pages again", async () => {
  const s = scriptedRunner(pauseRouter);
  const ctx = fakeContext({ repoDir: "/repo", repoLabel: "serve" });
  const res = await runScan(s.run, {}, ctx);
  const budgets = byWorkflow(res.lines, "swamp_workflow_stale_after_seconds");
  const last = byWorkflow(
    res.lines,
    "swamp_workflow_last_success_timestamp_seconds",
  );
  assert("eod-steward" in budgets);
  assert("eod-steward" in last);
});

Deno.test("scan: pauses are read from pauseServer with pauseToken when set", async () => {
  const s = scriptedRunner(pauseRouter);
  const ctx = fakeContext({
    repoDir: "/repo",
    repoLabel: "serve",
    pauseServer: "ws://127.0.0.1:9090",
    pauseToken: "watch.secret",
  });
  await runScan(s.run, {}, ctx);
  const call = s.calls.find((c) => c.args[1] === "schedule");
  assert(call);
  assertEquals(call.args, [
    "workflow",
    "schedule",
    "list",
    "--server",
    "ws://127.0.0.1:9090",
    "--token",
    "watch.secret",
    "--json",
  ]);
  // History is still read the way it was: locally, from the repo.
  const hist = s.calls.find((c) => c.args[1] === "history");
  assert(hist?.args.includes("--repo-dir"));
  assert(!hist?.args.includes("--server"));
});

Deno.test("scan: without pauseServer, pauses follow server and token", async () => {
  const s = scriptedRunner(pauseRouter);
  const ctx = fakeContext({
    repoDir: "/repo",
    repoLabel: "mac",
    server: "https://swamp.example",
    token: "mac.secret",
  });
  await runScan(s.run, {}, ctx);
  const call = s.calls.find((c) => c.args[1] === "schedule");
  assertEquals(call?.args.slice(3), [
    "--server",
    "https://swamp.example",
    "--token",
    "mac.secret",
    "--json",
  ]);
});

Deno.test("scan: a failed pause read reports every workflow active and flags the read", async () => {
  const s = scriptedRunner((args) => {
    if (args[1] === "schedule") {
      return ok(JSON.stringify({
        error:
          'Schedule pauses of a "@magistr/mongodb-datastore" datastore are kept in its shared control-plane store.',
      }));
    }
    return router(args);
  });
  const ctx = fakeContext({ repoDir: "/repo", repoLabel: "serve" });
  const res = await runScan(s.run, {}, ctx);
  assertEquals(res.scheduledCount, 4);
  assert(res.pauseError?.includes("control-plane store"));
  const paused = byWorkflow(res.lines, "swamp_workflow_paused");
  assertEquals(Object.values(paused).every((v) => v === 0), true);
  const ok0 = parseExposition(res.lines).find((m) =>
    m.name === "swamp_watch_pause_read_ok"
  );
  assertEquals(ok0?.value, 0);
});

Deno.test("scan: only an explicit paused:true counts as paused", async () => {
  const s = scriptedRunner((args) => {
    if (args[1] === "schedule") {
      return ok(JSON.stringify({
        schedules: [
          { workflowName: "fleet-health", paused: "true" },
          { workflowName: "daily-health", paused: 1 },
          { workflowName: "eod-steward" },
        ],
      }));
    }
    return router(args);
  });
  const ctx = fakeContext({ repoDir: "/repo", repoLabel: "serve" });
  const res = await runScan(s.run, {}, ctx);
  assertEquals(res.pausedWorkflows, []);
});
