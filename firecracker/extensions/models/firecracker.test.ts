import {
  AGENT_SCRIPT,
  buildDeployFabricCmd,
  buildKillVmmCmd,
  buildStartVmmCmd,
  FABRIC_SERVER_PY,
  fabricPaths,
} from "./firecracker.ts";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

// ---- Warm worker-loop agent ----

Deno.test("agent script is a warm worker loop, not one-shot", () => {
  assert(
    AGENT_SCRIPT.includes("worker ready; polling for tasks"),
    "agent should announce the worker loop",
  );
  assert(
    AGENT_SCRIPT.includes("http://172.16.0.1:8080/task"),
    "agent should poll for tasks",
  );
  assert(
    AGENT_SCRIPT.includes("claude --print --dangerously-skip-permissions"),
    "agent should run claude unattended",
  );
  assert(
    !AGENT_SCRIPT.includes("sleep 3600"),
    "warm worker must loop, not idle-forever after one task",
  );
});

Deno.test("worker tags each result with its task id (queue correlation)", () => {
  assert(
    AGENT_SCRIPT.includes("/result?id="),
    "result POST must carry the task id in the query",
  );
  assert(
    AGENT_SCRIPT.includes("X-Task-Id:"),
    "result POST must carry the X-Task-Id header",
  );
  assert(
    AGENT_SCRIPT.includes("get('id','')") || AGENT_SCRIPT.includes('get("id"'),
    "worker must read the task id from the served task json",
  );
});

Deno.test("reused worker gets a fresh per-task workspace and keeps the sandbox posture", () => {
  assert(
    AGENT_SCRIPT.includes("/workspace/job-"),
    "each task should use a fresh per-task workspace",
  );
  assert(
    AGENT_SCRIPT.includes("IS_SANDBOX=1"),
    "IS_SANDBOX must stay set for root skip-permissions",
  );
});

// ---- Fabric queue daemon ----

Deno.test("fabric daemon atomically claims tasks and never double-dispatches", () => {
  assert(
    FABRIC_SERVER_PY.includes("os.rename(path, dst)"),
    "claim must use an atomic rename so two workers never get the same task",
  );
  assert(
    FABRIC_SERVER_PY.includes("except OSError:") &&
      FABRIC_SERVER_PY.includes("continue"),
    "a worker that loses the claim race must try the next task",
  );
});

Deno.test("fabric daemon injects the token at serve time and never logs", () => {
  assert(
    FABRIC_SERVER_PY.includes('task["token"] = TOKEN'),
    "token must be injected at serve time, not stored in the queue",
  );
  assert(
    FABRIC_SERVER_PY.includes("def log_message(self, *a):"),
    "daemon must suppress request logging (token hygiene)",
  );
});

Deno.test("fabric daemon stores results by id and signals empty-queue with 204", () => {
  assert(
    FABRIC_SERVER_PY.includes('RESULTS_DIR, tid + ".txt"') ||
      FABRIC_SERVER_PY.includes('tid + ".txt"'),
    "results must be keyed by task id",
  );
  assert(
    FABRIC_SERVER_PY.includes("send_response(204)"),
    "empty queue must return 204 so the worker idle-polls",
  );
  assert(
    FABRIC_SERVER_PY.includes("os.rename(tmp, os.path.join(RESULTS_DIR"),
    "result publish must be atomic (tmp + rename)",
  );
});

// ---- Extracted command builders (reused by start_vmm/kill_vmm and the fabric) ----

Deno.test("fabricPaths derives queue/claimed/results under one root", () => {
  const p = fabricPaths("/tmp/fc-fabric");
  assert(p.queueDir === "/tmp/fc-fabric/queue", "queueDir");
  assert(p.claimedDir === "/tmp/fc-fabric/claimed", "claimedDir");
  assert(p.resultsDir === "/tmp/fc-fabric/results", "resultsDir");
});

Deno.test("buildStartVmmCmd launches firecracker in the given netns and reuses a warm process", () => {
  const c = buildStartVmmCmd("/tmp/fcw-1.socket", "fcw-1");
  assert(
    c.includes("ip netns exec 'fcw-1' firecracker --api-sock"),
    "must launch in the netns",
  );
  assert(c.includes("alive:"), "must reuse a warm VMM if already alive");
  const root = buildStartVmmCmd("/tmp/fc.socket");
  assert(!root.includes("ip netns exec"), "no netns -> root-namespace launch");
});

Deno.test("buildKillVmmCmd reaps PID + socket + netns + NAT for the given worker", () => {
  const c = buildKillVmmCmd("/tmp/fcw-1.socket", "fcw-1");
  assert(c.includes("ip netns del 'fcw-1'"), "must delete the netns");
  assert(
    c.includes("fc-netns:fcw-1"),
    "must flush this worker's tagged NAT rules",
  );
  assert(c.includes("kill -9"), "must escalate to SIGKILL");
});

Deno.test("buildDeployFabricCmd runs the daemon in the netns with the shared queue env", () => {
  const p = fabricPaths("/tmp/fc-fabric");
  const c = buildDeployFabricCmd(
    "fcw-1",
    "172.16.0.1",
    8080,
    p,
    "sk-ant-xxx",
    "/tmp/fcw-1.server.pid",
  );
  assert(
    c.includes("ip netns exec 'fcw-1' python3"),
    "daemon runs inside the worker netns",
  );
  assert(
    c.includes("FC_QUEUE_DIR='/tmp/fc-fabric/queue'"),
    "shared queue dir wired",
  );
  assert(c.includes("FC_OAUTH_TOKEN="), "token passed to the daemon env");
  assert(c.includes("base64 -d"), "server script written via base64");
});
