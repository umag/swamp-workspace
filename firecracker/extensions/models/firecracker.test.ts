import {
  AGENT_SCRIPT,
  buildDeployFabricCmd,
  buildDiscoverWorkersCmd,
  buildKillVmmCmd,
  buildQueuePayload,
  buildStartVmmCmd,
  FABRIC_SERVER_PY,
  fabricPaths,
  parsePollOutput,
  workerIndexFromNetns,
} from "./firecracker.ts";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

// ---------------------------------------------------------------------------
// Behavioral fabric-daemon tests. These run the REAL FABRIC_SERVER_PY out of
// process against a temp queue dir (no SSH / no VM needed) and exercise the
// actual claim/result/recycle/poison logic — not just substring presence.
// They are gated on python3 + the `run` permission so a restricted CI that
// can't spawn processes simply skips them; the pure-logic tests below always
// run.
// ---------------------------------------------------------------------------

async function daemonRunnable(): Promise<boolean> {
  try {
    const st = await Deno.permissions.query({ name: "run", command: "python3" });
    if (st.state !== "granted") return false;
    const out = await new Deno.Command("python3", { args: ["-c", "0"] })
      .output();
    return out.success;
  } catch {
    return false;
  }
}
const DAEMON_OK = await daemonRunnable();

async function bashRunnable(): Promise<boolean> {
  try {
    const st = await Deno.permissions.query({ name: "run", command: "bash" });
    if (st.state !== "granted") return false;
    return (await new Deno.Command("bash", { args: ["-c", ":"] }).output()).success;
  } catch {
    return false;
  }
}
const BASH_OK = await bashRunnable();

interface Daemon {
  proc: Deno.ChildProcess;
  port: number;
  dir: string;
  paths: ReturnType<typeof fabricPaths>;
  stop: () => Promise<void>;
}

async function startDaemon(netns: string, root?: string): Promise<Daemon> {
  const dir = root ?? await Deno.makeTempDir({ prefix: "fcfab-" });
  const paths = fabricPaths(dir);
  for (const d of [paths.queueDir, paths.claimedDir, paths.resultsDir, paths.failedDir]) {
    await Deno.mkdir(d, { recursive: true });
  }
  await Deno.writeTextFile(paths.serverPath, FABRIC_SERVER_PY);
  const port = 30000 + Math.floor(Math.random() * 25000);
  const proc = new Deno.Command("python3", {
    args: [paths.serverPath],
    env: {
      FC_QUEUE_DIR: paths.queueDir,
      FC_CLAIMED_DIR: paths.claimedDir,
      FC_RESULTS_DIR: paths.resultsDir,
      FC_FAILED_DIR: paths.failedDir,
      FC_BIND_IP: "127.0.0.1",
      FC_BIND_PORT: String(port),
      FC_NETNS: netns,
      FC_OAUTH_TOKEN: "sk-ant-secret",
    },
    stdout: "null",
    stderr: "null",
  }).spawn();
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/task`, { method: "HEAD" });
      await r.body?.cancel();
      break;
    } catch {
      await new Promise((res) => setTimeout(res, 50));
    }
  }
  const stop = async () => {
    try {
      proc.kill("SIGKILL");
    } catch { /* already gone */ }
    await proc.status;
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  };
  return { proc, port, dir, paths, stop };
}

async function seedTask(
  paths: ReturnType<typeof fabricPaths>,
  seq: string,
  id: string,
  payload: unknown,
): Promise<void> {
  await Deno.writeTextFile(
    `${paths.queueDir}/${seq}-${id}.json`,
    JSON.stringify(payload),
  );
}

async function getTask(
  port: number,
): Promise<{ status: number; body: Record<string, string> | null }> {
  const r = await fetch(`http://127.0.0.1:${port}/task`);
  if (r.status === 204) {
    await r.body?.cancel();
    return { status: 204, body: null };
  }
  return { status: r.status, body: await r.json() };
}

async function postResult(
  port: number,
  id: string,
  text: string,
): Promise<number> {
  const r = await fetch(
    `http://127.0.0.1:${port}/result?id=${encodeURIComponent(id)}`,
    { method: "POST", body: text, headers: { "X-Task-Id": id } },
  );
  await r.body?.cancel();
  return r.status;
}

function dirNames(dir: string): string[] {
  return [...Deno.readDirSync(dir)].map((e) => e.name);
}

Deno.test({
  name: "daemon: atomic claim serves each task to exactly one worker (no double-dispatch)",
  ignore: !DAEMON_OK,
  fn: async () => {
    const d = await startDaemon("w-1");
    try {
      const ids = ["aaaa", "bbbb", "cccc", "dddd"];
      for (let i = 0; i < ids.length; i++) {
        await seedTask(d.paths, String(1000 + i), ids[i], { id: ids[i], prompt: "x" });
      }
      // Fire MORE concurrent pollers than there are tasks.
      const results = await Promise.all(
        Array.from({ length: 10 }, () => getTask(d.port)),
      );
      const served = results.filter((r) => r.status === 200).map((r) => r.body!.id);
      const empties = results.filter((r) => r.status === 204).length;
      assert(new Set(served).size === served.length, "no task served twice");
      assert(new Set(served).size === ids.length, "every task served exactly once");
      assert(empties === 10 - ids.length, "surplus pollers get 204");
      const full = results.find((r) => r.status === 200)!.body!;
      assert(full.token === "sk-ant-secret", "token injected at serve time");
    } finally {
      await d.stop();
    }
  },
});

Deno.test({
  name: "daemon: POST result writes results/<id>.txt and clears the worker's claim",
  ignore: !DAEMON_OK,
  fn: async () => {
    const d = await startDaemon("w-1");
    try {
      await seedTask(d.paths, "1000", "task1", { id: "task1", prompt: "x" });
      const t = await getTask(d.port);
      assert(t.status === 200 && t.body!.id === "task1", "claimed task1");
      assert(
        dirNames(d.paths.claimedDir).some((n) => n.includes("task1")),
        "claim recorded under the worker netns",
      );
      assert(await postResult(d.port, "task1", "the-answer") === 200, "post ok");
      assert(
        await Deno.readTextFile(`${d.paths.resultsDir}/task1.txt`) === "the-answer",
        "result stored by id",
      );
      assert(
        !dirNames(d.paths.claimedDir).some((n) => n.includes("task1")),
        "own claim cleared once the result lands",
      );
    } finally {
      await d.stop();
    }
  },
});

Deno.test({
  name: "daemon: a stale late result cannot clobber another worker's re-claimed task (requeue race)",
  ignore: !DAEMON_OK,
  fn: async () => {
    const root = await Deno.makeTempDir({ prefix: "fcfab-" });
    const d1 = await startDaemon("w-1", root);
    const d2 = await startDaemon("w-2", root);
    try {
      await seedTask(d1.paths, "1000", "shared", { id: "shared", prompt: "x" });
      const a = await getTask(d1.port);
      assert(a.status === 200 && a.body!.id === "shared", "w-1 claimed it");
      // Simulate fabric_recycle requeueing w-1's stalled claim back to the queue.
      const claim1 = dirNames(d1.paths.claimedDir).find((n) => n.startsWith("w-1__"))!;
      const orig = claim1.slice(claim1.indexOf("__") + 2);
      await Deno.rename(`${d1.paths.claimedDir}/${claim1}`, `${d1.paths.queueDir}/${orig}`);
      // w-2 re-claims the requeued task.
      const b = await getTask(d2.port);
      assert(b.status === 200 && b.body!.id === "shared", "w-2 re-claimed it");
      const claim2 = dirNames(d2.paths.claimedDir).find((n) => n.startsWith("w-2__"))!;
      // The OLD slow worker (w-1) now posts a stale result: must be DROPPED and
      // must NOT delete w-2's live claim.
      assert(await postResult(d1.port, "shared", "STALE-from-w1") === 200, "stale post acked");
      assert(
        dirNames(d2.paths.claimedDir).includes(claim2),
        "w-2's claim survives the stale post (no cross-worker deletion)",
      );
      let wrote = true;
      try {
        await Deno.readTextFile(`${root}/results/shared.txt`);
      } catch {
        wrote = false;
      }
      assert(!wrote, "the stale worker wrote no result");
      // The live claim holder (w-2) posts and wins.
      assert(await postResult(d2.port, "shared", "REAL-from-w2") === 200, "live post ok");
      assert(
        await Deno.readTextFile(`${root}/results/shared.txt`) === "REAL-from-w2",
        "only the live claim holder's result is recorded",
      );
    } finally {
      await d1.stop();
      await d2.stop();
    }
  },
});

Deno.test({
  name: "daemon: a malformed task is quarantined to failed/ and never wedges the queue",
  ignore: !DAEMON_OK,
  fn: async () => {
    const d = await startDaemon("w-1");
    try {
      // Poison sorts ahead of the good task (lower seq).
      await Deno.writeTextFile(`${d.paths.queueDir}/1000-poison.json`, "{ this is not json");
      await seedTask(d.paths, "1001", "good", { id: "good", prompt: "x" });
      // One poll: claim_next hits the poison, quarantines it, and continues to the
      // good task in the same call.
      const t = await getTask(d.port);
      assert(t.status === 200 && t.body!.id === "good", "good task served despite poison ahead of it");
      assert(
        dirNames(d.paths.failedDir).some((n) => n.includes("poison")),
        "poison quarantined to failed/",
      );
      assert(
        (await Deno.readTextFile(`${d.paths.resultsDir}/poison.txt`)).startsWith("ERROR"),
        "poison surfaced an error result keyed by id",
      );
      assert(
        !dirNames(d.paths.claimedDir).some((n) => n.includes("poison")),
        "poison is not stuck in claimed/",
      );
    } finally {
      await d.stop();
    }
  },
});

// ---------------------------------------------------------------------------
// Pure in-process logic (no SSH, no python) — always runs.
// ---------------------------------------------------------------------------

Deno.test("buildQueuePayload excludes the OAuth token (credential-hygiene boundary)", () => {
  const p = buildQueuePayload(
    { prompt: "hi", model: "m", effort: "low", gitRepoUrl: "u" },
    "id1",
  );
  assert(
    JSON.stringify(Object.keys(p).sort()) ===
      JSON.stringify(["effort", "gitRepoUrl", "id", "model", "prompt"]),
    "exactly the 5 non-secret fields are serialized",
  );
  assert(!JSON.stringify(p).toLowerCase().includes("token"), "no token key in the queue payload");
  assert(!JSON.stringify(p).includes("sk-ant"), "no credential value in the queue payload");
  assert(
    p.id === "id1" && p.prompt === "hi" && p.model === "m" &&
      p.effort === "low" && p.gitRepoUrl === "u",
    "supplied values pass through to the right fields (no swap/drop)",
  );
  const min = buildQueuePayload({ prompt: "x" }, "id2");
  assert(
    min.model === "" && min.effort === "" && min.gitRepoUrl === "",
    "optional fields default to empty strings",
  );
});

Deno.test("parsePollOutput decodes the id->result map and the pending count", () => {
  const stdout = `===alpha===\n${btoa("hello")}\n===beta===\n${btoa("world")}\nPENDING=3\n`;
  const { completed, pending } = parsePollOutput(stdout);
  assert(completed.alpha === "hello", "alpha decoded from base64");
  assert(completed.beta === "world", "beta decoded from base64");
  assert(pending === 3, "pending count parsed");
  const empty = parsePollOutput("PENDING=0\n");
  assert(Object.keys(empty.completed).length === 0 && empty.pending === 0, "no results, zero pending");
  const bad = parsePollOutput("===corrupt===\n!!!not-base64!!!\nPENDING=0\n");
  assert(bad.completed.corrupt === "", "a corrupt result line decodes to empty, never throws");
});

Deno.test({
  // Regression guard for the live bug the re-smoke caught: a brace group split
  // across newlines with a leading/orphaned pipe is a bash syntax error.
  name: "buildDiscoverWorkersCmd emits syntactically valid bash (plain/hyphenated/dotted prefix)",
  ignore: !BASH_OK,
  fn: async () => {
    for (const pfx of ["fcw", "fc-w", "fc.w"]) {
      const cmd = buildDiscoverWorkersCmd(pfx);
      const out = await new Deno.Command("bash", { args: ["-n", "-c", cmd] }).output();
      assert(
        out.success,
        `bash -n rejected discover cmd for prefix '${pfx}': ${new TextDecoder().decode(out.stderr)}`,
      );
      assert(cmd.includes("grep -E"), "discover must filter to the prefix's worker netns");
    }
  },
});

Deno.test("workerIndexFromNetns maps a netns to its worker slot and rejects junk", () => {
  assert(workerIndexFromNetns("fcw-3") === 3, "default prefix");
  assert(workerIndexFromNetns("fc-w-12") === 12, "hyphenated prefix -> trailing int");
  assert(workerIndexFromNetns("fcw-0") === null, "0 rejected (slots are 1-based)");
  assert(workerIndexFromNetns("fcw-256") === 256, "upper bound accepted");
  assert(workerIndexFromNetns("fcw-257") === null, "just past the upper bound rejected");
  assert(workerIndexFromNetns("fcw-999") === null, "out-of-range index rejected");
  assert(workerIndexFromNetns("fcw-abc") === null, "non-numeric rejected");
  assert(workerIndexFromNetns("default") === null, "a netns with no index is rejected");
});

// ---------------------------------------------------------------------------
// Command builders (pure) + the baked agent script (structural — the in-guest
// PID-1 agent can't be exercised without a VM, so structure is the best check).
// ---------------------------------------------------------------------------

Deno.test("agent script is a warm worker loop, not one-shot", () => {
  assert(AGENT_SCRIPT.includes("worker ready; polling for tasks"), "announces the worker loop");
  assert(AGENT_SCRIPT.includes("http://172.16.0.1:8080/task"), "polls for tasks");
  assert(AGENT_SCRIPT.includes("claude --print --dangerously-skip-permissions"), "runs claude unattended");
  assert(!AGENT_SCRIPT.includes("sleep 3600"), "loops rather than idling forever after one task");
});

Deno.test("worker tags each result with its task id (queue correlation)", () => {
  assert(AGENT_SCRIPT.includes("/result?id="), "result POST carries the id in the query");
  assert(AGENT_SCRIPT.includes("X-Task-Id:"), "result POST carries the X-Task-Id header");
});

Deno.test("reused worker gets a fresh per-task workspace and keeps the sandbox posture", () => {
  assert(AGENT_SCRIPT.includes("/workspace/job-"), "fresh per-task workspace");
  assert(AGENT_SCRIPT.includes("IS_SANDBOX=1"), "IS_SANDBOX stays set for root skip-permissions");
});

Deno.test("fabricPaths derives queue/claimed/results/failed under one root", () => {
  const p = fabricPaths("/tmp/fc-fabric");
  assert(p.queueDir === "/tmp/fc-fabric/queue", "queueDir");
  assert(p.claimedDir === "/tmp/fc-fabric/claimed", "claimedDir");
  assert(p.resultsDir === "/tmp/fc-fabric/results", "resultsDir");
  assert(p.failedDir === "/tmp/fc-fabric/failed", "failedDir");
});

Deno.test("buildStartVmmCmd launches firecracker in the given netns and reuses a warm process", () => {
  const c = buildStartVmmCmd("/tmp/fcw-1.socket", "fcw-1");
  assert(c.includes("ip netns exec 'fcw-1' firecracker --api-sock"), "launches in the netns");
  assert(c.includes("alive:"), "reuses a warm VMM if already alive");
  const root = buildStartVmmCmd("/tmp/fc.socket");
  assert(!root.includes("ip netns exec"), "no netns -> root-namespace launch");
});

Deno.test("buildKillVmmCmd reaps PID + socket + netns + NAT for the given worker", () => {
  const c = buildKillVmmCmd("/tmp/fcw-1.socket", "fcw-1");
  assert(c.includes("ip netns del 'fcw-1'"), "deletes the netns");
  assert(c.includes("fc-netns:fcw-1"), "flushes this worker's tagged NAT rules");
  assert(c.includes("kill -9"), "escalates to SIGKILL");
});

Deno.test("buildDeployFabricCmd runs the daemon in the netns with the shared queue env", () => {
  const p = fabricPaths("/tmp/fc-fabric");
  const c = buildDeployFabricCmd("fcw-1", "172.16.0.1", 8080, p, "sk-ant-xxx", "/tmp/fcw-1.server.pid");
  assert(c.includes("ip netns exec 'fcw-1' python3"), "daemon runs inside the worker netns");
  assert(c.includes("FC_QUEUE_DIR='/tmp/fc-fabric/queue'"), "shared queue dir wired");
  assert(c.includes("FC_FAILED_DIR='/tmp/fc-fabric/failed'"), "failed/quarantine dir wired");
  assert(c.includes("FC_OAUTH_TOKEN="), "token passed to the daemon env");
  assert(c.includes("base64 -d"), "server script written via base64");
});
