/**
 * adversarial suite for @magistr/swamp-watch.
 *
 * The hostile inputs here are not hypothetical. This model reads its own
 * repo's workflow names and a server's error text, then turns both into
 * Prometheus label values and alert routing decisions. A workflow name is
 * attacker-adjacent the moment anyone can add a file to the repo, and a
 * server's error text is not under this model's control at all.
 */

import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import { historyFor, runDrift, runScan, summarise } from "./swamp_watch.ts";
import { escapeLabelValue, metricLine, parseCron } from "./lib/cli.ts";
import {
  fail,
  fakeContext,
  ok,
  parseExposition,
  scriptedRunner,
} from "./lib/testing.ts";

const noSleep = () => Promise.resolve();

Deno.test("adversarial: a workflow name with quotes and newlines cannot forge a series", () => {
  const evil =
    'x" } 9999\nswamp_workflow_last_success_timestamp_seconds{workflow="victim';
  const line = metricLine("swamp_workflow_runs", { workflow: evil }, 1);
  // One physical line only — an injected newline would otherwise be read by
  // Prometheus as a second, attacker-chosen sample.
  assertEquals(line.split("\n").length, 1);
  const parsed = parseExposition(line);
  assertEquals(parsed.length, 1);
  assertEquals(parsed[0].name, "swamp_workflow_runs");
});

Deno.test("adversarial: backslashes and quotes are escaped, not dropped", () => {
  assertEquals(escapeLabelValue('a"b'), 'a\\"b');
  assertEquals(escapeLabelValue("a\\b"), "a\\\\b");
  assertEquals(escapeLabelValue("a\nb"), "a\\nb");
  // Escaping order matters: escaping the quote first and the backslash second
  // would double-process the inserted backslash.
  assertEquals(escapeLabelValue('\\"'), '\\\\\\"');
});

Deno.test("adversarial: unparseable CLI output is rejected, not treated as empty", async () => {
  const s = scriptedRunner(() => ok("this is not json"));
  const ctx = fakeContext({ repoDir: "/repo" });
  await assertRejects(() => runScan(s.run, {}, ctx));
});

Deno.test("adversarial: a structured CLI error on stdout is surfaced, not parsed as data", async () => {
  const s = scriptedRunner(() =>
    ok(JSON.stringify({ error: 'Unknown option "--server".' }))
  );
  const ctx = fakeContext({ repoDir: "/repo" });
  await assertRejects(
    () => runScan(s.run, {}, ctx),
    Error,
    "Unknown option",
  );
});

Deno.test("adversarial: history records for another workflow are discarded", async () => {
  // A name-filtered search is a server-side query, not a guarantee. Counting a
  // foreign record would let a chatty workflow keep a dead one looking alive:
  // the victim would show a fresh success it never had.
  const s = scriptedRunner(() =>
    ok(JSON.stringify({
      results: [
        {
          startedAt: "2026-08-20T22:00:00.000Z",
          status: "succeeded",
          workflowName: "fleet-health",
        },
        {
          startedAt: "2026-08-01T00:00:00.000Z",
          status: "succeeded",
          workflowName: "victim",
        },
      ],
    }))
  );
  const records = await historyFor(s.run, "swamp", "victim", {
    repoDir: "/repo",
    timeoutMs: 1000,
  });
  assertEquals(records.length, 1);
  const stat = summarise("victim", "0 3 * * *", records, 0.5, 1800);
  assertEquals(stat.lastSuccess, "2026-08-01T00:00:00.000Z");
});

Deno.test("adversarial: a server error mentioning 'not found' for another reason still needs the workflow shape", async () => {
  const s = scriptedRunner((args) => {
    if (args[1] === "list") {
      return ok(JSON.stringify({
        results: [{ name: "a", trigger: { schedule: "0 3 * * *" } }],
      }));
    }
    return fail("Authentication failed - run: swamp auth server-login");
  });
  const ctx = fakeContext({
    repoDir: "/repo",
    server: "https://serve.example",
    retryBackoffMs: 0,
  });
  const res = await runDrift(s.run, {}, ctx, noSleep);
  // An auth failure must never be reported as deploy drift: that would page
  // "workflow not deployed" for a workflow that is deployed and fine.
  assertEquals(res.missing.length, 0);
  assertEquals(res.errors.length, 1);
});

Deno.test("adversarial: malformed cron fields are rejected rather than silently accepted", () => {
  for (
    const bad of [
      "* * * *", // four fields
      "* * * * * *", // six fields
      "60 * * * *", // minute out of range
      "* 24 * * *", // hour out of range
      "*/0 * * * *", // zero step
      "5-1 * * * *", // inverted range
      "a * * * *", // not a number
      "* * * * ", // trailing empty is fine, but this has only four
    ]
  ) {
    let threw = false;
    try {
      parseCron(bad);
    } catch {
      threw = true;
    }
    assert(threw, `expected "${bad}" to be rejected`);
  }
});

Deno.test("adversarial: an unparseable schedule degrades to no budget, never to a wrong one", () => {
  const stat = summarise("weird", "@yearly", [], 0.5, 1800);
  // A guessed budget is worse than none: it would either page constantly or
  // silently never page at all.
  assertEquals(stat.expectedPeriodSeconds, null);
  assertEquals(stat.staleAfterSeconds, null);
});

Deno.test("adversarial: a history read failure records the error and keeps the workflow visible", async () => {
  const s = scriptedRunner((args) => {
    if (args[1] === "list") {
      return ok(JSON.stringify({
        results: [{ name: "a", trigger: { schedule: "0 3 * * *" } }],
      }));
    }
    return fail("connection reset");
  });
  const ctx = fakeContext({ repoDir: "/repo", repoLabel: "serve" });
  const res = await runScan(s.run, {}, ctx);
  assertEquals(res.workflows.length, 1);
  assert(res.workflows[0].historyError !== null);
  // Dropping the workflow would take its series with it — and a vanished
  // series cannot fire the alert this model exists to raise.
  const names = parseExposition(res.lines)
    .filter((x) => x.name === "swamp_workflow_stale_after_seconds")
    .map((x) => x.labels.workflow);
  assertEquals(names, ["a"]);
});

Deno.test("adversarial: non-object and nameless list entries are skipped, not crashed on", async () => {
  const s = scriptedRunner((args) =>
    args[1] === "list"
      ? ok(JSON.stringify({
        results: [
          null,
          "a string",
          { trigger: { schedule: "0 3 * * *" } },
          { name: "", trigger: { schedule: "0 3 * * *" } },
          { name: "good", trigger: { schedule: "0 3 * * *" } },
        ],
      }))
      : ok(JSON.stringify({ results: [] }))
  );
  const ctx = fakeContext({ repoDir: "/repo", repoLabel: "serve" });
  const res = await runScan(s.run, {}, ctx);
  assertEquals(res.workflows.map((w) => w.workflow), ["good"]);
});

Deno.test("adversarial: a token is never placed in a command that has no server", async () => {
  const s = scriptedRunner((args) =>
    args[1] === "list"
      ? ok(JSON.stringify({
        results: [{ name: "a", trigger: { schedule: "0 3 * * *" } }],
      }))
      : ok(JSON.stringify({ results: [] }))
  );
  const ctx = fakeContext({
    repoDir: "/repo",
    repoLabel: "serve",
    token: "secret.value",
  });
  await runScan(s.run, {}, ctx);
  for (const call of s.calls) {
    assert(
      !call.args.includes("secret.value"),
      `token leaked into local call: ${call.args.join(" ")}`,
    );
  }
});
