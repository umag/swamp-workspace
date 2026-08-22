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
