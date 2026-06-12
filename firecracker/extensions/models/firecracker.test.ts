import {
  AGENT_SCRIPT,
  buildDeployFabricCmd,
  buildDiscoverWorkersCmd,
  buildKillVmmCmd,
  buildQueuePayload,
  buildSetupTapScript,
  buildStartVmmCmd,
  buildVerifyNetnsCmd,
  deriveVethAddrs,
  FABRIC_SERVER_PY,
  fabricPaths,
  parsePollOutput,
  utf8ToBase64,
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
    const st = await Deno.permissions.query({
      name: "run",
      command: "python3",
    });
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
    return (await new Deno.Command("bash", { args: ["-c", ":"] }).output())
      .success;
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
  for (
    const d of [
      paths.queueDir,
      paths.claimedDir,
      paths.resultsDir,
      paths.failedDir,
    ]
  ) {
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
      const r = await fetch(`http://127.0.0.1:${port}/task`, {
        method: "HEAD",
      });
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
  name:
    "daemon: atomic claim serves each task to exactly one worker (no double-dispatch)",
  ignore: !DAEMON_OK,
  fn: async () => {
    const d = await startDaemon("w-1");
    try {
      const ids = ["aaaa", "bbbb", "cccc", "dddd"];
      for (let i = 0; i < ids.length; i++) {
        await seedTask(d.paths, String(1000 + i), ids[i], {
          id: ids[i],
          prompt: "x",
        });
      }
      // Fire MORE concurrent pollers than there are tasks.
      const results = await Promise.all(
        Array.from({ length: 10 }, () => getTask(d.port)),
      );
      const served = results.filter((r) => r.status === 200).map((r) =>
        r.body!.id
      );
      const empties = results.filter((r) => r.status === 204).length;
      assert(new Set(served).size === served.length, "no task served twice");
      assert(
        new Set(served).size === ids.length,
        "every task served exactly once",
      );
      assert(empties === 10 - ids.length, "surplus pollers get 204");
      const full = results.find((r) => r.status === 200)!.body!;
      assert(full.token === "sk-ant-secret", "token injected at serve time");
    } finally {
      await d.stop();
    }
  },
});

Deno.test({
  name:
    "daemon: POST result writes results/<id>.txt and clears the worker's claim",
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
      assert(
        await postResult(d.port, "task1", "the-answer") === 200,
        "post ok",
      );
      assert(
        await Deno.readTextFile(`${d.paths.resultsDir}/task1.txt`) ===
          "the-answer",
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
  name:
    "daemon: a stale late result cannot clobber another worker's re-claimed task (requeue race)",
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
      const claim1 = dirNames(d1.paths.claimedDir).find((n) =>
        n.startsWith("w-1__")
      )!;
      const orig = claim1.slice(claim1.indexOf("__") + 2);
      await Deno.rename(
        `${d1.paths.claimedDir}/${claim1}`,
        `${d1.paths.queueDir}/${orig}`,
      );
      // w-2 re-claims the requeued task.
      const b = await getTask(d2.port);
      assert(b.status === 200 && b.body!.id === "shared", "w-2 re-claimed it");
      const claim2 = dirNames(d2.paths.claimedDir).find((n) =>
        n.startsWith("w-2__")
      )!;
      // The OLD slow worker (w-1) now posts a stale result: must be DROPPED and
      // must NOT delete w-2's live claim.
      assert(
        await postResult(d1.port, "shared", "STALE-from-w1") === 200,
        "stale post acked",
      );
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
      assert(
        await postResult(d2.port, "shared", "REAL-from-w2") === 200,
        "live post ok",
      );
      assert(
        await Deno.readTextFile(`${root}/results/shared.txt`) ===
          "REAL-from-w2",
        "only the live claim holder's result is recorded",
      );
    } finally {
      await d1.stop();
      await d2.stop();
    }
  },
});

Deno.test({
  name:
    "daemon: a malformed task is quarantined to failed/ and never wedges the queue",
  ignore: !DAEMON_OK,
  fn: async () => {
    const d = await startDaemon("w-1");
    try {
      // Poison sorts ahead of the good task (lower seq).
      await Deno.writeTextFile(
        `${d.paths.queueDir}/1000-poison.json`,
        "{ this is not json",
      );
      await seedTask(d.paths, "1001", "good", { id: "good", prompt: "x" });
      // One poll: claim_next hits the poison, quarantines it, and continues to the
      // good task in the same call.
      const t = await getTask(d.port);
      assert(
        t.status === 200 && t.body!.id === "good",
        "good task served despite poison ahead of it",
      );
      assert(
        dirNames(d.paths.failedDir).some((n) => n.includes("poison")),
        "poison quarantined to failed/",
      );
      assert(
        (await Deno.readTextFile(`${d.paths.resultsDir}/poison.txt`))
          .startsWith("ERROR"),
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
  assert(
    !JSON.stringify(p).toLowerCase().includes("token"),
    "no token key in the queue payload",
  );
  assert(
    !JSON.stringify(p).includes("sk-ant"),
    "no credential value in the queue payload",
  );
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
  const stdout = `===alpha===\n${btoa("hello")}\n===beta===\n${
    btoa("world")
  }\nPENDING=3\n`;
  const { completed, pending } = parsePollOutput(stdout);
  assert(completed.alpha === "hello", "alpha decoded from base64");
  assert(completed.beta === "world", "beta decoded from base64");
  assert(pending === 3, "pending count parsed");
  const empty = parsePollOutput("PENDING=0\n");
  assert(
    Object.keys(empty.completed).length === 0 && empty.pending === 0,
    "no results, zero pending",
  );
  const bad = parsePollOutput("===corrupt===\n!!!not-base64!!!\nPENDING=0\n");
  assert(
    bad.completed.corrupt === "",
    "a corrupt result line decodes to empty, never throws",
  );
});

Deno.test("base64 round-trips non-Latin1 task/result content (emoji, box-drawing, CJK)", () => {
  // The submit prompt embeds file content and the poll result echoes it back;
  // both can carry non-ASCII (the exact chars an ascii-fix task edits). Plain
  // btoa/atob only handle Latin1 — btoa throws "outside of the Latin1 range" and
  // atob corrupts multibyte chars — so submit must encode via utf8ToBase64 and
  // parsePollOutput must UTF-8-decode. (Regression: this once blocked a whole run.)
  const s = "best 🏆 stop 🛑 tree ├── `-- │ CJK 日本語";
  let plainBtoaThrew = false;
  try {
    btoa(s);
  } catch {
    plainBtoaThrew = true;
  }
  assert(
    plainBtoaThrew,
    "plain btoa throws on non-Latin1 — why utf8ToBase64 exists",
  );

  // submit-side encode -> the daemon's `base64 -w0` of the UTF-8 result bytes is
  // byte-identical, so feeding it back through parsePollOutput is the real path.
  const b64 = utf8ToBase64(s);
  const { completed } = parsePollOutput(`===t1===\n${b64}\nPENDING=0\n`);
  assert(
    completed.t1 === s,
    "non-Latin1 content survives the encode->decode round-trip",
  );
});

Deno.test({
  // Regression guard for the live bug the re-smoke caught: a brace group split
  // across newlines with a leading/orphaned pipe is a bash syntax error.
  name:
    "buildDiscoverWorkersCmd emits syntactically valid bash (plain/hyphenated/dotted prefix)",
  ignore: !BASH_OK,
  fn: async () => {
    for (const pfx of ["fcw", "fc-w", "fc.w"]) {
      const cmd = buildDiscoverWorkersCmd(pfx);
      const out = await new Deno.Command("bash", { args: ["-n", "-c", cmd] })
        .output();
      assert(
        out.success,
        `bash -n rejected discover cmd for prefix '${pfx}': ${
          new TextDecoder().decode(out.stderr)
        }`,
      );
      assert(
        cmd.includes("grep -E"),
        "discover must filter to the prefix's worker netns",
      );
    }
  },
});

Deno.test("workerIndexFromNetns maps a netns to its worker slot and rejects junk", () => {
  assert(workerIndexFromNetns("fcw-3") === 3, "default prefix");
  assert(
    workerIndexFromNetns("fc-w-12") === 12,
    "hyphenated prefix -> trailing int",
  );
  assert(
    workerIndexFromNetns("fcw-0") === null,
    "0 rejected (slots are 1-based)",
  );
  assert(workerIndexFromNetns("fcw-256") === 256, "upper bound accepted");
  assert(
    workerIndexFromNetns("fcw-257") === null,
    "just past the upper bound rejected",
  );
  assert(
    workerIndexFromNetns("fcw-999") === null,
    "out-of-range index rejected",
  );
  assert(workerIndexFromNetns("fcw-abc") === null, "non-numeric rejected");
  assert(
    workerIndexFromNetns("default") === null,
    "a netns with no index is rejected",
  );
});

// ---------------------------------------------------------------------------
// Command builders (pure) + the baked agent script (structural — the in-guest
// PID-1 agent can't be exercised without a VM, so structure is the best check).
// ---------------------------------------------------------------------------

Deno.test("agent script is a warm worker loop, not one-shot", () => {
  assert(
    AGENT_SCRIPT.includes("worker ready; polling for tasks"),
    "announces the worker loop",
  );
  assert(
    AGENT_SCRIPT.includes("http://172.16.0.1:8080/task"),
    "polls for tasks",
  );
  assert(
    AGENT_SCRIPT.includes("claude --print --dangerously-skip-permissions"),
    "runs claude unattended",
  );
  assert(
    !AGENT_SCRIPT.includes("sleep 3600"),
    "loops rather than idling forever after one task",
  );
});

Deno.test("worker tags each result with its task id (queue correlation)", () => {
  assert(
    AGENT_SCRIPT.includes("/result?id="),
    "result POST carries the id in the query",
  );
  assert(
    AGENT_SCRIPT.includes("X-Task-Id:"),
    "result POST carries the X-Task-Id header",
  );
});

Deno.test("reused worker gets a fresh per-task workspace and keeps the sandbox posture", () => {
  assert(AGENT_SCRIPT.includes("/workspace/job-"), "fresh per-task workspace");
  assert(
    AGENT_SCRIPT.includes("IS_SANDBOX=1"),
    "IS_SANDBOX stays set for root skip-permissions",
  );
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
  assert(
    c.includes("ip netns exec 'fcw-1' firecracker --api-sock"),
    "launches in the netns",
  );
  assert(c.includes("alive:"), "reuses a warm VMM if already alive");
  const root = buildStartVmmCmd("/tmp/fc.socket");
  assert(!root.includes("ip netns exec"), "no netns -> root-namespace launch");
});

Deno.test("buildKillVmmCmd reaps PID + socket + netns + NAT for the given worker", () => {
  const c = buildKillVmmCmd("/tmp/fcw-1.socket", "fcw-1");
  assert(c.includes("ip netns del 'fcw-1'"), "deletes the netns");
  assert(
    c.includes("fc-netns:fcw-1"),
    "flushes this worker's tagged NAT rules",
  );
  assert(c.includes("kill -9"), "escalates to SIGKILL");
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
  assert(
    c.includes("FC_FAILED_DIR='/tmp/fc-fabric/failed'"),
    "failed/quarantine dir wired",
  );
  assert(c.includes("FC_OAUTH_TOKEN="), "token passed to the daemon env");
  assert(c.includes("base64 -d"), "server script written via base64");
});

// ---------------------------------------------------------------------------
// netns uplink wiring: the fabric_up "worker counted ready while its netns
// lacks the veth uplink" race. The fix lives in three pure builders, so the
// repair/verify/fail-fast properties are asserted on the generated shell.
// ---------------------------------------------------------------------------

Deno.test("deriveVethAddrs derives host (.1), ns (.2) and prefix from a veth subnet", () => {
  const a = deriveVethAddrs("10.0.1.0/30");
  assert(a.vethHostIp === "10.0.1.1", "host/gateway is .1");
  assert(a.vethNsIp === "10.0.1.2", "namespace side is .2");
  assert(a.vethPrefix === "30", "prefix preserved");
});

Deno.test("buildSetupTapScript repairs the veth keyed on the NS-side fcveth0 (not the root-side veth)", () => {
  const c = buildSetupTapScript({
    tapName: "tap0",
    hostIp: "172.16.0.1",
    prefix: 24,
    guestSubnet: "172.16.0.0/24",
    netns: "sip-1",
    vethSubnet: "10.0.1.0/30",
  });
  // The (re)creation gate probes the ns-side peer, the end that actually
  // determines guest egress, then rebuilds the pair only when it is missing.
  assert(
    c.includes("ip netns exec 'sip-1' ip link show fcveth0 2>/dev/null || {"),
    "gates veth (re)creation on the ns-side fcveth0",
  );
  assert(
    c.includes("type veth peer name fcveth0 netns 'sip-1'"),
    "recreates the pair with fcveth0 in the namespace",
  );
  // A stale root-side half is deleted before re-add, and that delete must be
  // guarded so first boot (no device yet) does not abort the script.
  assert(
    /ip link del 'fcv[0-9a-f]+' 2>\/dev\/null \|\| true/.test(c),
    "stale root-side veth deleted, guarded by `|| true`",
  );
  // Must NOT short-circuit on the root-side veth (the original asymmetric bug:
  // `ip link show <rootVeth> || ip link add ...`).
  assert(
    !/ip link show 'fcv[0-9a-f]+' 2>\/dev\/null \|\| ip link add/.test(c),
    "does not gate solely on the root-side veth",
  );
});

Deno.test("buildSetupTapScript fails fast when the host has no default route", () => {
  const c = buildSetupTapScript({
    tapName: "tap0",
    hostIp: "172.16.0.1",
    prefix: 24,
    guestSubnet: "172.16.0.0/24",
    netns: "sip-1",
    vethSubnet: "10.0.1.0/30",
  });
  assert(
    c.includes(`[ -n "$UP" ] ||`) && c.includes("no host default route"),
    "aborts (exit 1) instead of building a host MASQUERADE with an empty -o",
  );
  // The fail-fast must precede the host MASQUERADE that consumes $UP.
  assert(
    c.indexOf(`[ -n "$UP" ] ||`) <
      c.indexOf('-o "$UP" -m comment'),
    "the $UP guard comes before the host egress rule",
  );
});

Deno.test("buildSetupTapScript root-namespace path stays byte-identical", () => {
  const c = buildSetupTapScript({
    tapName: "tap0",
    hostIp: "172.16.0.1",
    prefix: 24,
    guestSubnet: "172.16.0.0/24",
  });
  const expected = [
    `ip link show 'tap0' 2>/dev/null || ip tuntap add dev 'tap0' mode tap`,
    `ip addr show 'tap0' | grep -q '172.16.0.1' || ip addr add '172.16.0.1/24' dev 'tap0'`,
    `ip link set 'tap0' up`,
    `sysctl -w net.ipv4.ip_forward=1 -q`,
    `iptables -t nat -C POSTROUTING -s '172.16.0.0/24' -j MASQUERADE 2>/dev/null || ` +
    `iptables -t nat -A POSTROUTING -s '172.16.0.0/24' -j MASQUERADE`,
    `echo ok`,
  ].join("\n");
  assert(c === expected, "root-namespace recipe unchanged");
});

Deno.test("buildVerifyNetnsCmd asserts fcveth0 addr + tap up + default route, shellEsc + grep -qwF", () => {
  const c = buildVerifyNetnsCmd("sip-1", "10.0.1.0/30", "tap0");
  assert(
    c.includes("ip netns exec 'sip-1' ip -o -4 addr show dev fcveth0"),
    "checks fcveth0 inside the namespace",
  );
  assert(
    c.includes("grep -qwF '10.0.1.2'"),
    "matches the ns veth IP literally + word-bounded",
  );
  assert(
    c.includes("ip netns exec 'sip-1' ip link show 'tap0' up"),
    "checks the in-ns tap is up",
  );
  assert(
    c.includes("grep -qwF 'default via 10.0.1.1'"),
    "checks the default route via the veth gateway",
  );
  assert(
    (c.match(/exit 1/g) ?? []).length >= 3,
    "each missing-wiring check exits non-zero",
  );
  // The literal word-bounded flag must be on EVERY IP/route check, so it can't
  // be quietly dropped from one and re-admit a substring false-positive.
  assert(
    (c.match(/grep -qwF /g) ?? []).length >= 3,
    "fcveth0 addr, tap, and default route all matched with grep -qwF",
  );
  assert(c.includes("echo verified"), "emits a success sentinel");
});

Deno.test("buildVerifyNetnsCmd shellEsc's an injection-bearing netns/tap (safe by construction)", () => {
  const c = buildVerifyNetnsCmd("a'b", "10.0.1.0/30", "t'p");
  // shellEsc wraps and escapes embedded quotes — no raw quote reaches the shell.
  assert(c.includes(`'a'\\''b'`), "netns single-quote escaped");
  assert(c.includes(`'t'\\''p'`), "tap single-quote escaped");
});

Deno.test({
  // grep -qwF is the load-bearing flag: the original "looks ready but isn't"
  // class is exactly a substring/metachar false match (10.0.1.2 vs 10.0.1.20).
  name: "verify grep -qwF rejects a near-miss address (10.0.1.2 != 10.0.1.20)",
  ignore: !BASH_OK,
  fn: async () => {
    const hit = await new Deno.Command("bash", {
      args: ["-c", `printf '%s\\n' 'inet 10.0.1.2/30' | grep -qwF '10.0.1.2'`],
    }).output();
    assert(hit.success, "the exact veth IP matches");
    const miss = await new Deno.Command("bash", {
      args: ["-c", `printf '%s\\n' 'inet 10.0.1.20/30' | grep -qwF '10.0.1.2'`],
    }).output();
    assert(!miss.success, "a longer sibling addr (10.0.1.20) is NOT a match");
    const route = await new Deno.Command("bash", {
      args: [
        "-c",
        `printf '%s\\n' 'default via 10.0.1.10 dev fcveth0' | grep -qwF 'default via 10.0.1.1'`,
      ],
    }).output();
    assert(!route.success, "a sibling gateway (10.0.1.10) is NOT a match");
  },
});

Deno.test({
  // Regression guard: the new netns veth brace-group and buildVerifyNetnsCmd's
  // three `|| { ...; exit 1; }` groups are the same brace-across-newlines shape
  // that previously shipped a bash syntax error — keep them syntax-checked.
  name: "netns setup_tap + buildVerifyNetnsCmd emit syntactically valid bash",
  ignore: !BASH_OK,
  fn: async () => {
    const setup = buildSetupTapScript({
      tapName: "tap0",
      hostIp: "172.16.0.1",
      prefix: 24,
      guestSubnet: "172.16.0.0/24",
      netns: "sip-1",
      vethSubnet: "10.0.1.0/30",
    });
    const verify = buildVerifyNetnsCmd("sip-1", "10.0.1.0/30", "tap0");
    for (const [label, script] of [["setup_tap", setup], ["verify", verify]]) {
      const out = await new Deno.Command("bash", { args: ["-n", "-c", script] })
        .output();
      assert(
        out.success,
        `bash -n rejected ${label}: ${new TextDecoder().decode(out.stderr)}`,
      );
    }
  },
});
