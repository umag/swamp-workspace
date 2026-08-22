/**
 * coverage suite for @magistr/swamp-watch.
 *
 * Every test here pins a guard that was added because the un-guarded version
 * was observed failing against the live server during development. Delete the
 * guard and one of these goes red.
 */

import { assert, assertEquals } from "jsr:@std/assert@1";
import { listDeclared, runDrift, runScan, summarise } from "./swamp_watch.ts";
import {
  isoToUnixSeconds,
  mapPool,
  maxGapSeconds,
  nameFromWorkflowYaml,
  scheduleFromWorkflowYaml,
  staleAfterSeconds,
} from "./lib/cli.ts";
import {
  byWorkflow,
  fail,
  fakeContext,
  ok,
  scriptedRunner,
} from "./lib/testing.ts";

const noSleep = () => Promise.resolve();

function listOf(...names: string[]) {
  return ok(JSON.stringify({
    results: names.map((n) => ({
      name: n,
      trigger: { schedule: "0 3 * * *" },
    })),
  }));
}

Deno.test("guard: 'Workflow not found' arriving on STDERR is still classified as drift", async () => {
  // The CLI prints this to stderr, so it reaches the model on the error's
  // `detail` rather than its message. Classifying on the message alone filed
  // every real drift as a broken probe and reported missing=0.
  const s = scriptedRunner((args) =>
    args[1] === "list" ? listOf("gone") : fail(
      "Error: Server reported workflow_get_failed: Workflow not found: gone",
    )
  );
  const ctx = fakeContext({
    repoDir: "/repo",
    server: "https://serve.example",
    retryBackoffMs: 0,
  });
  const res = await runDrift(s.run, {}, ctx, noSleep);
  assertEquals(res.missing.map((m) => m.workflow), ["gone"]);
  assertEquals(res.errors.length, 0);
});

Deno.test("guard: a transient probe failure is retried once before being given up on", async () => {
  let attempts = 0;
  const s = scriptedRunner((args) => {
    if (args[1] === "list") return listOf("flaky");
    attempts++;
    return attempts === 1
      ? fail("Authentication failed")
      : ok(JSON.stringify({ name: "flaky" }));
  });
  const ctx = fakeContext({
    repoDir: "/repo",
    server: "https://serve.example",
    retryBackoffMs: 0,
  });
  const res = await runDrift(s.run, {}, ctx, noSleep);
  assertEquals(attempts, 2);
  assertEquals(res.presentCount, 1);
  assertEquals(res.errors.length, 0);
});

Deno.test("guard: a genuinely missing workflow is NOT retried", async () => {
  let attempts = 0;
  const s = scriptedRunner((args) => {
    if (args[1] === "list") return listOf("gone");
    attempts++;
    return fail("Workflow not found: gone");
  });
  const ctx = fakeContext({
    repoDir: "/repo",
    server: "https://serve.example",
    retryBackoffMs: 0,
  });
  await runDrift(s.run, {}, ctx, noSleep);
  // Retrying a 404 doubles load on a server that is already refusing under
  // concurrency, which is what turned 2 probe errors into 6.
  assertEquals(attempts, 1);
});

Deno.test("guard: the retry backs off rather than hammering", async () => {
  const slept: number[] = [];
  const s = scriptedRunner((args) =>
    args[1] === "list" ? listOf("flaky") : fail("Authentication failed")
  );
  const ctx = fakeContext({
    repoDir: "/repo",
    server: "https://serve.example",
    retryBackoffMs: 1500,
  });
  await runDrift(s.run, {}, ctx, (ms) => {
    slept.push(ms);
    return Promise.resolve();
  });
  assertEquals(slept, [1500]);
});

Deno.test("guard: mapPool preserves input order and honours its limit", async () => {
  let inFlight = 0;
  let peak = 0;
  const out = await mapPool([1, 2, 3, 4, 5, 6, 7], 2, async (n) => {
    inFlight++;
    peak = Math.max(peak, inFlight);
    await Promise.resolve();
    inFlight--;
    return n * 10;
  });
  assertEquals(out, [10, 20, 30, 40, 50, 60, 70]);
  assert(peak <= 2, `peak concurrency ${peak} exceeded the limit`);
});

Deno.test("guard: mapPool on an empty list does no work and returns empty", async () => {
  const out = await mapPool([], 4, () => Promise.reject(new Error("never")));
  assertEquals(out, []);
});

Deno.test("guard: the staleness budget uses the LONGEST gap, not the average", () => {
  // Two fires a day, but 11h then 13h. A budget from the 12h average pages
  // every single night on the 13h leg.
  assertEquals(maxGapSeconds("0 9,20 * * *"), 46800);
  assert(46800 > 43200);
});

Deno.test("guard: day-of-month and day-of-week are ORed when both are restricted", () => {
  // Vixie-cron semantics. ANDing them makes "the 1st, and every Sunday" look
  // monthly, inflating the budget by roughly 30x.
  const both = maxGapSeconds("0 0 1 * 0");
  const domOnly = maxGapSeconds("0 0 1 * *");
  assert(both !== null && domOnly !== null);
  assert(
    both < domOnly,
    `OR semantics should shorten the gap: ${both} vs ${domOnly}`,
  );
  assertEquals(both, 604800);
});

Deno.test("guard: the grace floor keeps a two-minute schedule from alerting on scan jitter", () => {
  // 3x120s would be 6 minutes — shorter than a sane scan interval, so the
  // alert would fire between scans on a perfectly healthy workflow.
  assertEquals(staleAfterSeconds(120, 0.5, 1800), 1920);
  // The fractional grace takes over once it exceeds the floor.
  assertEquals(staleAfterSeconds(86400, 0.5, 1800), 129600);
});

Deno.test("guard: an unparseable timestamp becomes 0, never NaN", () => {
  // NaN in exposition text is a parse error at ingest, which would drop the
  // whole push — every workflow's series, not just the bad one.
  assertEquals(isoToUnixSeconds("not a date"), 0);
  assertEquals(isoToUnixSeconds(null), 0);
  assertEquals(isoToUnixSeconds(undefined), 0);
  assertEquals(isoToUnixSeconds(""), 0);
});

Deno.test("guard: no emitted metric value is ever NaN", async () => {
  const s = scriptedRunner((args) =>
    args[1] === "list" ? listOf("a") : ok(JSON.stringify({
      results: [{
        startedAt: "garbage",
        status: "succeeded",
        workflowName: "a",
      }],
    }))
  );
  const ctx = fakeContext({ repoDir: "/repo", repoLabel: "serve" });
  const res = await runScan(s.run, {}, ctx);
  assert(!res.lines.includes("NaN"));
  assertEquals(
    byWorkflow(res.lines, "swamp_workflow_last_success_timestamp_seconds")["a"],
    0,
  );
});

Deno.test("guard: scan and drift never share a resource instance name", async () => {
  const s = scriptedRunner((args) => {
    if (args[1] === "list") return listOf("a");
    if (args[1] === "history") return ok(JSON.stringify({ results: [] }));
    return ok(JSON.stringify({ name: "a" }));
  });
  const ctx = fakeContext({
    repoDir: "/repo",
    repoLabel: "serve",
    server: "https://serve.example",
    retryBackoffMs: 0,
  });
  await runScan(s.run, {}, ctx);
  await runDrift(s.run, {}, ctx, noSleep);
  const instances = ctx.written.map((w) => w.instance);
  assertEquals(new Set(instances).size, instances.length);
});

Deno.test("guard: a `schedule:` inside a description block scalar is not mistaken for the trigger", () => {
  // These workflow descriptions genuinely contain lines like
  // `schedule: "0 8 * * *"` as prose. Reading the first match anywhere in the
  // file would attach a wrong budget to the workflow — silently, and forever.
  const yaml = [
    "id: abc",
    "name: reading-list-daily",
    "description: >-",
    "  Runs on the serve scheduler.",
    '  schedule: "0 3 * * *" is the OLD value, do not use it.',
    "trigger:",
    '  schedule: "0 8 * * *"',
    "tags: {}",
  ].join("\n");
  assertEquals(scheduleFromWorkflowYaml(yaml), "0 8 * * *");
  assertEquals(nameFromWorkflowYaml(yaml), "reading-list-daily");
});

Deno.test("guard: a workflow with no trigger block yields no schedule", () => {
  const yaml = "id: abc\nname: manual-thing\ntags: {}\njobs: []\n";
  assertEquals(scheduleFromWorkflowYaml(yaml), null);
});

Deno.test("guard: an empty trigger block does not invent a schedule", () => {
  assertEquals(scheduleFromWorkflowYaml("name: x\ntrigger:\njobs: []\n"), null);
});

Deno.test("guard: quoted and unquoted schedules both parse", () => {
  assertEquals(
    scheduleFromWorkflowYaml('name: x\ntrigger:\n  schedule: "*/2 * * * *"\n'),
    "*/2 * * * *",
  );
  assertEquals(
    scheduleFromWorkflowYaml("name: x\ntrigger:\n  schedule: '0 3 * * *'\n"),
    "0 3 * * *",
  );
  assertEquals(
    scheduleFromWorkflowYaml("name: x\ntrigger:\n  schedule: 0 3 * * *\n"),
    "0 3 * * *",
  );
});

Deno.test("guard: the on-disk fallback fills in what the CLI omits", async () => {
  // Reproduces swamp 20260815, which returns every workflow WITHOUT a trigger
  // field while still registering its schedule. Without the fallback the scan
  // reports zero workflows and the whole alert group monitors nothing.
  const files: Record<string, string> = {
    "workflow-a.yaml":
      'id: a\nname: fleet-health\ntrigger:\n  schedule: "*/2 * * * *"\n',
    "workflow-b.yaml": "id: b\nname: manual-thing\ntags: {}\n",
    "notes.txt": "ignored",
  };
  const fs = {
    readDir: async function* (_p: string) {
      for (const name of Object.keys(files)) yield { name, isFile: true };
    },
    readTextFile: (p: string) =>
      Promise.resolve(files[p.split("/").pop() as string]),
  };
  const s = scriptedRunner(() =>
    ok(JSON.stringify({
      results: [{ name: "fleet-health" }, { name: "manual-thing" }],
    }))
  );
  const declared = await listDeclared(s.run, "swamp", "/repo", 1000, false, fs);
  assertEquals(declared.map((d) => `${d.name}=${d.schedule}`), [
    "fleet-health=*/2 * * * *",
  ]);
});

Deno.test("guard: an unreadable workflows directory degrades instead of failing the scan", async () => {
  const fs = {
    // deno-lint-ignore require-yield
    readDir: async function* (_p: string) {
      throw new Error("ENOENT");
    },
    readTextFile: () => Promise.resolve(""),
  };
  const s = scriptedRunner(() =>
    ok(JSON.stringify({
      results: [{ name: "a", trigger: { schedule: "0 3 * * *" } }],
    }))
  );
  const declared = await listDeclared(s.run, "swamp", "/repo", 1000, false, fs);
  assertEquals(declared.length, 1);
});

Deno.test("guard: a budget override replaces the cron-derived budget", () => {
  const s = summarise(
    "anime-fetch-airing",
    "0 * * * *",
    [],
    0.5,
    1800,
    null,
    21600,
  );
  assertEquals(s.expectedPeriodSeconds, 3600);
  // The cron-derived budget would be 5400; the override must win.
  assertEquals(s.staleAfterSeconds, 21600);
});

Deno.test("guard: an override applies even when the schedule cannot be parsed", () => {
  // Otherwise "do not page about this one yet" would silently not apply to
  // exactly the workflows whose schedule is unusual.
  const s = summarise("weird", "@yearly", [], 0.5, 1800, null, 21600);
  assertEquals(s.expectedPeriodSeconds, null);
  assertEquals(s.staleAfterSeconds, 21600);
});

Deno.test("guard: no override leaves the cron-derived budget untouched", () => {
  assertEquals(
    summarise("x", "0 * * * *", [], 0.5, 1800).staleAfterSeconds,
    5400,
  );
  assertEquals(
    summarise("x", "0 * * * *", [], 0.5, 1800, null, null).staleAfterSeconds,
    5400,
  );
});
