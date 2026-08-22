/**
 * contract-fixture suite for @magistr/swamp-watch.
 *
 * Pins the swamp CLI wire format this model depends on, with no process
 * spawned. If a swamp release changes the shape of `workflow list --json` or
 * `workflow history search --json`, these tests are where it surfaces —
 * rather than in a scan that silently reports every workflow as never having
 * run, which would read as a fleet-wide outage.
 */

import { assert, assertEquals } from "jsr:@std/assert@1";
import { historyFor, listDeclared, summarise } from "./swamp_watch.ts";
import { ok, scriptedRunner } from "./lib/testing.ts";
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

Deno.test("contract: workflow list exposes trigger.schedule and is filtered to scheduled workflows", async () => {
  const s = scriptedRunner(() => ok(LIST));
  const declared = await listDeclared(s.run, "swamp", "/repo", 1000);
  assertEquals(declared.map((d) => d.name), [
    "daily-health",
    "eod-steward",
    "ext-canary-nightly",
    "fleet-health",
  ]);
  // pihole-dns-list carries no trigger and must not appear.
  assert(!declared.some((d) => d.name === "pihole-dns-list"));
  assertEquals(
    declared.find((d) => d.name === "daily-health")?.schedule,
    "0 9,20 * * *",
  );
});

Deno.test("contract: workflow list is read locally, never with --server", async () => {
  const s = scriptedRunner(() => ok(LIST));
  await listDeclared(s.run, "swamp", "/repo", 1000);
  const args = s.calls[0].args;
  assertEquals(args.slice(0, 2), ["workflow", "list"]);
  assert(args.includes("--repo-dir"));
  // `workflow list` rejects --server outright; sending it would break the
  // whole scan rather than degrade it.
  assert(!args.includes("--server"));
});

Deno.test("contract: includeUnscheduled surfaces workflows with no trigger", async () => {
  const s = scriptedRunner(() => ok(LIST));
  const declared = await listDeclared(s.run, "swamp", "/repo", 1000, true);
  assertEquals(declared.length, 5);
  assertEquals(
    declared.find((d) => d.name === "pihole-dns-list")?.schedule,
    "",
  );
});

Deno.test("contract: a run record carries exactly runId/startedAt/status/workflowId/workflowName", () => {
  const rec = historyFleet.results[0] as Record<string, unknown>;
  assertEquals(
    Object.keys(rec).sort(),
    ["runId", "startedAt", "status", "workflowId", "workflowName"],
  );
  // No duration and no error: the reason the OTel phase of the plan exists.
  assert(!("duration" in rec));
  assert(!("error" in rec));
});

Deno.test("contract: history is asked per workflow, by name, with --server when configured", async () => {
  const s = scriptedRunner(() => ok(FLEET));
  await historyFor(s.run, "swamp", "fleet-health", {
    repoDir: "/repo",
    server: "https://serve.example",
    token: "t.sec",
    timeoutMs: 1000,
  });
  assertEquals(s.calls[0].args.slice(0, 4), [
    "workflow",
    "history",
    "search",
    "fleet-health",
  ]);
  assert(s.calls[0].args.includes("--server"));
  assert(s.calls[0].args.includes("t.sec"));
  // A server read must not also pass --repo-dir; the two select different
  // history stores and the local one lags the server by many hours.
  assert(!s.calls[0].args.includes("--repo-dir"));
});

Deno.test("contract: without a server, history is read from the repo directory", async () => {
  const s = scriptedRunner(() => ok(FLEET));
  await historyFor(s.run, "swamp", "fleet-health", {
    repoDir: "/repo",
    timeoutMs: 1000,
  });
  assert(s.calls[0].args.includes("--repo-dir"));
  assert(!s.calls[0].args.includes("--server"));
});

Deno.test("contract: statuses fold to succeeded/failed/other and last success wins", async () => {
  const s = scriptedRunner(() => ok(FLEET));
  const records = await historyFor(s.run, "swamp", "fleet-health", {
    repoDir: "/repo",
    timeoutMs: 1000,
  });
  const stat = summarise("fleet-health", "*/2 * * * *", records, 0.5, 1800);
  assertEquals(stat.runs, 4);
  assertEquals(stat.succeeded, 2);
  assertEquals(stat.failed, 1);
  // `cancelled` is a real third status in swamp and must not be counted as a
  // failure, or every restart would burn error budget.
  assertEquals(stat.other, 1);
  assertEquals(stat.lastSuccess, "2026-08-20T22:20:00.804Z");
  assertEquals(stat.lastStatus, "succeeded");
});

Deno.test("contract: an empty history is a real answer, not an error", async () => {
  const s = scriptedRunner(() => ok(EMPTY));
  const records = await historyFor(s.run, "swamp", "ext-canary-nightly", {
    repoDir: "/repo",
    timeoutMs: 1000,
  });
  assertEquals(records.length, 0);
  const stat = summarise("ext-canary-nightly", "0 3 * * *", records, 0.5, 1800);
  assertEquals(stat.lastSuccess, null);
  assertEquals(stat.expectedPeriodSeconds, 86400);
});
