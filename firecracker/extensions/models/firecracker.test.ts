import { AGENT_SCRIPT } from "./firecracker.ts";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

// Warm-VM reuse: the PID-1 agent must be a worker LOOP (poll -> run -> post ->
// repeat), not one-task-then-idle. These assertions fail on the old one-shot
// agent and pass on the looping worker.
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
  // The old one-shot agent idled forever after a single task; the worker must not.
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
