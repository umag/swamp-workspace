/**
 * Adversarial suite: destructive-blast-radius guard characterization
 * (createZfsPool's device-availability guard, fixed in BOTH directions —
 * cozystack-linstor-fail-open-guards), option-injection via missing `--`
 * sentinels, hostile/malformed linstor output, retry exhaustion under
 * FakeTime, and a k8s/kubeconfig-tuned fixtures-secret-scan.
 *
 * createZfsPool's idempotency key WAS (node, storagePool NAME) only, never
 * `device` — reusing an already-provisioned device under a different pool
 * name fell through to the destructive `create-device-pool` call (a device
 * wipe), and the mirror case (same pool name, different device) silently
 * no-opped without ever provisioning the requested device. Both directions
 * are now FIXED: a `physical-storage list` inventory read establishes
 * device availability, folded into a 4-way decision alongside the
 * (node, storagePool) name match. Every other test in this file still PINS
 * current, unrelated behavior (including behavior that is a real,
 * documented gap elsewhere) rather than proposing a fix.
 */
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import { FakeTime } from "jsr:@std/testing@1/time";
import { model } from "./cozystack_linstor.ts";
import nodeList from "../../fixtures/node-list.json" with { type: "json" };
import storagePoolList from "../../fixtures/storage-pool-list.json" with {
  type: "json",
};
import deployReady from "../../fixtures/deploy-ready.json" with {
  type: "json",
};
import deployNotReady from "../../fixtures/deploy-notready.json" with {
  type: "json",
};
import physicalStorageList from "../../fixtures/physical-storage-list.json" with {
  type: "json",
};

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

type Resp = { success: boolean; stdout: string; stderr: string };
type Invocation = { command: string; args: string[] };

function installCmdStub(queue: Resp[]) {
  const invocations: Invocation[] = [];
  const original = Deno.Command;
  const enc = new TextEncoder();
  // deno-lint-ignore no-explicit-any
  (Deno as any).Command = class {
    #cmd: string;
    #args: string[];
    constructor(cmd: string, opts: { args: string[] }) {
      this.#cmd = cmd;
      this.#args = opts.args;
    }
    output() {
      invocations.push({ command: this.#cmd, args: this.#args });
      const r = queue.shift() ?? { success: true, stdout: "", stderr: "" };
      return Promise.resolve({
        success: r.success,
        code: r.success ? 0 : 1,
        signal: null,
        stdout: enc.encode(r.stdout),
        stderr: enc.encode(r.stderr),
      });
    }
  };
  return {
    invocations,
    // deno-lint-ignore no-explicit-any
    restore: () => ((Deno as any).Command = original),
  };
}

type Written = { spec: string; name: string; payload: Record<string, unknown> };

function makeCtx() {
  const written: Written[] = [];
  return {
    written,
    ctx: {
      globalArgs: {},
      writeResource: (spec: string, name: string, payload: unknown) => {
        written.push({
          spec,
          name,
          payload: payload as Record<string, unknown>,
        });
        return Promise.resolve({ spec, name });
      },
      logger: { info: () => {}, warning: () => {} },
    },
  };
}

type MethodMap = Record<string, {
  arguments: { parse: (a: unknown) => unknown };
  execute: (a: unknown, c: unknown) => Promise<unknown>;
}>;

function run(name: string, args: Record<string, unknown>, ctx: unknown) {
  const method = (model.methods as MethodMap)[name];
  return method.execute(method.arguments.parse(args), ctx);
}

// ---------------------------------------------------------------------------
// createZfsPool: the device-availability guard, characterized in BOTH
// directions (cozystack-linstor-fail-open-guards)
// ---------------------------------------------------------------------------
// The name-only `nameMatch` (cozystack_linstor.ts ~427-430,
// `p.stor_pool_name === args.storagePool && p.node_name === args.node`) is
// now folded together with `deviceFree` (from a `physical-storage list`
// inventory read) into a 4-way decision:
//   nameMatch && !deviceFree   -> idempotent no-op (pool exists, device
//                                 consumed — consistent state)
//   nameMatch && deviceFree    -> DIRECTION B: reject (same pool name, a
//                                 DIFFERENT still-unclaimed device)
//   !nameMatch && !deviceFree  -> DIRECTION A: reject (no matching pool, but
//                                 the requested device is already in use —
//                                 creating would WIPE it)
//   !nameMatch && deviceFree   -> create (legit new node+pool+device)
// Previously, `nameMatch` alone decided everything: a different storagePool
// NAME on the node caused a FAIL-OPEN WIPE (create proceeded even though the
// device already held data), and the SAME storagePool name regardless of
// device caused a FAIL-OPEN NO-OP (silently never provisioning a different
// requested device). Both are fixed below.

Deno.test("createZfsPool: exact (node, storagePool) match with the device already claimed — idempotent no-op, only the two read calls are issued", async () => {
  const existing = JSON.stringify([{
    stor_pools: [{ node_name: "worker-0", stor_pool_name: "data" }],
  }]);
  const noFreeDevices = JSON.stringify([{ physical_storage: [] }]);
  const stub = installCmdStub([
    { success: true, stdout: existing, stderr: "" },
    { success: true, stdout: noFreeDevices, stderr: "" },
  ]);
  const { ctx, written } = makeCtx();
  try {
    await run("createZfsPool", { node: "worker-0", device: "/dev/vdb" }, ctx);
  } finally {
    stub.restore();
  }
  assertEquals(
    stub.invocations.length,
    2,
    "the pre-flight list call and the physical-storage inventory read; no create call",
  );
  const res = written.find((w) => w.name === "create-zfs-worker-0-data")!;
  assertEquals(res.payload.success, true);
});

Deno.test("createZfsPool DIRECTION B (fixed): same (node, storagePool NAME) but a DIFFERENT, still-unclaimed requested device is REFUSED — success:false, no create-device-pool call", async () => {
  // Previously: `device` was absent from the idempotency decision entirely,
  // so a pool-NAME match under a different device was silently suppressed as
  // "already exists" (success:true) — the requested device was never
  // provisioned and the caller was never told. Now: nameMatch && deviceFree
  // is Direction B — the guard REFUSES instead of silently discarding the
  // request.
  const existing = JSON.stringify([{
    stor_pools: [{ node_name: "worker-0", stor_pool_name: "data" }],
  }]);
  const deviceStillFree = JSON.stringify([{
    physical_storage: [{
      size: 10737418240,
      rotational: false,
      nodes: { "worker-0": [{ device: "/dev/vdb-replacement" }] },
    }],
  }]);
  const stub = installCmdStub([
    { success: true, stdout: existing, stderr: "" },
    { success: true, stdout: deviceStillFree, stderr: "" },
  ]);
  const { ctx, written } = makeCtx();
  try {
    await run(
      "createZfsPool",
      { node: "worker-0", device: "/dev/vdb-replacement", storagePool: "data" },
      ctx,
    );
  } finally {
    stub.restore();
  }
  assertEquals(
    stub.invocations.length,
    2,
    "both reads are issued; create-device-pool is refused before it would run",
  );
  assert(
    !stub.invocations.some((i) => i.args.includes("create-device-pool")),
    "the requested device must NOT be silently discarded nor provisioned",
  );
  const res = written.find((w) => w.name === "create-zfs-worker-0-data")!;
  assertEquals(res.payload.success, false);
  assert(
    (res.payload.message as string).includes("/dev/vdb-replacement"),
    "the refusal names the conflicting device",
  );
});

Deno.test("createZfsPool DIRECTION A (fixed): an existing pool under a DIFFERENT storagePool name, requested device NOT available — REFUSED, the device wipe is NOT issued", async () => {
  // Previously: an existing pool under a different storagePool NAME did not
  // match nameMatch, so the destructive create-device-pool call proceeded
  // even though the requested device already held data (a device wipe).
  // Now: the physical-storage inventory read shows the requested device is
  // NOT available (absent = already backing some other pool), so
  // !nameMatch && !deviceFree is Direction A — the guard REFUSES.
  const existingUnderDifferentName = JSON.stringify([{
    stor_pools: [{ node_name: "worker-0", stor_pool_name: "legacy" }],
  }]);
  const deviceInUse = JSON.stringify([{ physical_storage: [] }]);
  const stub = installCmdStub([
    { success: true, stdout: existingUnderDifferentName, stderr: "" },
    { success: true, stdout: deviceInUse, stderr: "" },
  ]);
  const { ctx, written } = makeCtx();
  try {
    await run(
      "createZfsPool",
      { node: "worker-0", device: "/dev/vdb", storagePool: "data" },
      ctx,
    );
  } finally {
    stub.restore();
  }
  assertEquals(
    stub.invocations.length,
    2,
    "both reads are issued; create-device-pool is refused before it would run",
  );
  assert(
    !stub.invocations.some((i) => i.args.includes("create-device-pool")),
    "the device wipe must NOT be issued",
  );
  const res = written.find((w) => w.name === "create-zfs-worker-0-data")!;
  assertEquals(res.payload.success, false);
  assert(
    (res.payload.message as string).includes("/dev/vdb"),
    "the refusal names the device",
  );
});

Deno.test("createZfsPool: an existing pool under the SAME storagePool name but on a DIFFERENT node does NOT short-circuit — create IS issued (the `node_name` conjunct, tested in isolation)", async () => {
  // The find() predicate is an AND of two conjuncts (stor_pool_name ===
  // args.storagePool && node_name === args.node). The test above varies the
  // storagePool-name conjunct; this one varies the node_name conjunct in
  // isolation, at the JS level — a real `linstor storage-pool list -n
  // <node>` would normally already be server-side filtered to one node, so
  // this scenario is a unit-level characterization of the predicate itself
  // (what the JS code does if handed a pool for another node), not a claim
  // about a realistic linstor response shape.
  const stub = installCmdStub([
    {
      success: true,
      stdout: JSON.stringify([{
        stor_pools: [{ node_name: "worker-9", stor_pool_name: "data" }],
      }]),
      stderr: "",
    },
    {
      success: true,
      stdout: JSON.stringify([{
        physical_storage: [{
          size: 10737418240,
          rotational: false,
          nodes: { "worker-0": [{ device: "/dev/vdb" }] },
        }],
      }]),
      stderr: "",
    },
    { success: true, stdout: "", stderr: "" },
  ]);
  const { ctx } = makeCtx();
  try {
    await run("createZfsPool", { node: "worker-0", device: "/dev/vdb" }, ctx);
  } finally {
    stub.restore();
  }
  assertEquals(
    stub.invocations.length,
    3,
    "the existing pool is on a different node — nameMatch must not match, and the requested device is available, so create proceeds",
  );
  assert(stub.invocations[2].args.includes("create-device-pool"));
});

Deno.test("createZfsPool: an EMPTY pre-flight list ([]) with the device available issues the create-device-pool call", async () => {
  const stub = installCmdStub([
    { success: true, stdout: JSON.stringify([{ stor_pools: [] }]), stderr: "" },
    {
      success: true,
      stdout: JSON.stringify([{
        physical_storage: [{
          size: 10737418240,
          rotational: false,
          nodes: { "worker-0": [{ device: "/dev/vdb" }] },
        }],
      }]),
      stderr: "",
    },
    { success: true, stdout: "", stderr: "" },
  ]);
  const { ctx } = makeCtx();
  try {
    await run("createZfsPool", { node: "worker-0", device: "/dev/vdb" }, ctx);
  } finally {
    stub.restore();
  }
  assertEquals(stub.invocations.length, 3);
  assert(stub.invocations[2].args.includes("create-device-pool"));
});

Deno.test("createZfsPool: a `{}` (non-array truthy) pre-flight payload throws BEFORE any create call — fail-CLOSED", async () => {
  const stub = installCmdStub([{ success: true, stdout: "{}", stderr: "" }]);
  const { ctx } = makeCtx();
  try {
    await assertRejects(
      () => run("createZfsPool", { node: "worker-0", device: "/dev/vdb" }, ctx),
      TypeError,
    );
  } finally {
    stub.restore();
  }
  assertEquals(
    stub.invocations.length,
    1,
    "pools.find threw before any create call",
  );
});

Deno.test("createZfsPool: a non-JSON pre-flight payload throws a SyntaxError BEFORE any create call — fail-CLOSED", async () => {
  const stub = installCmdStub([{
    success: true,
    stdout: "not-json",
    stderr: "",
  }]);
  const { ctx } = makeCtx();
  try {
    await assertRejects(
      () => run("createZfsPool", { node: "worker-0", device: "/dev/vdb" }, ctx),
      SyntaxError,
    );
  } finally {
    stub.restore();
  }
  assertEquals(stub.invocations.length, 1);
});

// ---------------------------------------------------------------------------
// Option / argument injection — no `--` sentinel guards any positional argv
// ---------------------------------------------------------------------------
// node/device (create), poolName/storagePool (zpool set / create), and
// manifestPath (kubectl apply -f) are emitted as bare positional argv with
// NO `--` sentinel. Assertions below are FULL ARRAY equality (not
// `.includes()`/`.join()`), so a future `--`-adding fix would turn them red.

Deno.test("OPTION INJECTION: a `-`-leading device value lands verbatim in create-device-pool's exact positional slot", async () => {
  const stub = installCmdStub([
    { success: true, stdout: JSON.stringify([{ stor_pools: [] }]), stderr: "" },
    {
      success: true,
      stdout: JSON.stringify([{
        physical_storage: [{
          size: 10737418240,
          rotational: false,
          nodes: { "worker-0": [{ device: "--force" }] },
        }],
      }]),
      stderr: "",
    },
    { success: true, stdout: "", stderr: "" },
  ]);
  const { ctx } = makeCtx();
  try {
    await run(
      "createZfsPool",
      {
        node: "worker-0",
        device: "--force",
        poolName: "-y",
        storagePool: "data",
      },
      ctx,
    );
  } finally {
    stub.restore();
  }
  assertEquals(stub.invocations[2].args, [
    "exec",
    "-n",
    "cozy-linstor",
    "deploy/linstor-controller",
    "--",
    "linstor",
    "physical-storage",
    "create-device-pool",
    "zfs",
    "worker-0",
    "--force",
    "--pool-name",
    "-y",
    "--storage-pool",
    "data",
  ]);
});

Deno.test("OPTION INJECTION: a `-`-leading node value lands verbatim in the pre-flight list's `-n` slot", async () => {
  const stub = installCmdStub([
    { success: true, stdout: JSON.stringify([{ stor_pools: [] }]), stderr: "" },
    {
      success: true,
      stdout: JSON.stringify([{ physical_storage: [] }]),
      stderr: "",
    },
    { success: true, stdout: "", stderr: "" },
  ]);
  const { ctx } = makeCtx();
  try {
    await run("createZfsPool", { node: "--all", device: "/dev/vdb" }, ctx);
  } finally {
    stub.restore();
  }
  assertEquals(stub.invocations[0].args, [
    "exec",
    "-n",
    "cozy-linstor",
    "deploy/linstor-controller",
    "--",
    "linstor",
    "storage-pool",
    "list",
    "-n",
    "--all",
    "--output-version=v1",
    "-m",
  ]);
});

Deno.test("OPTION INJECTION: a `-`-leading manifestPath is passed straight to `kubectl apply -f`, reparsable as a flag (or stdin via a bare '-')", async () => {
  const stub = installCmdStub([{ success: true, stdout: "", stderr: "" }]);
  const { ctx } = makeCtx();
  try {
    await run("applyStorageClasses", { manifestPath: "-" }, ctx);
  } finally {
    stub.restore();
  }
  assertEquals(stub.invocations[0].args, ["apply", "-f", "-"]);
});

Deno.test("OPTION INJECTION: a `-`-leading poolName lands verbatim in setZfsFailmode's `zpool set` positional slot", async () => {
  const stub = installCmdStub([{ success: true, stdout: "", stderr: "" }]);
  const { ctx } = makeCtx();
  try {
    await run("setZfsFailmode", { node: "worker-0", poolName: "--force" }, ctx);
  } finally {
    stub.restore();
  }
  assertEquals(stub.invocations[0].args, [
    "exec",
    "-n",
    "cozy-linstor",
    "ds/linstor-satellite.worker-0",
    "--",
    "zpool",
    "set",
    "failmode=continue",
    "--force",
  ]);
});

// ---------------------------------------------------------------------------
// Hostile output split — OBJECT (loud TypeError) vs STRING (silent per-char
// corruption) vs non-JSON (SyntaxError), per read method
// ---------------------------------------------------------------------------

Deno.test("pin: an OBJECT-shaped linstor payload makes listNodes throw — `for..of` over a non-iterable object (loud, pinned as a bug)", async () => {
  const stub = installCmdStub([{ success: true, stdout: "{}", stderr: "" }]);
  const { ctx } = makeCtx();
  try {
    await assertRejects(() => run("listNodes", {}, ctx), TypeError);
  } finally {
    stub.restore();
  }
});

Deno.test("pin: a STRING-shaped linstor payload makes listNodes iterate CHARACTERS — silent per-character garbage writes, worse than the loud object case", async () => {
  const stub = installCmdStub([
    { success: true, stdout: JSON.stringify("ab"), stderr: "" },
  ]);
  const { ctx, written } = makeCtx();
  try {
    await run("listNodes", {}, ctx);
  } finally {
    stub.restore();
  }
  const nodeWrites = written.filter((w) => w.spec === "node");
  assertEquals(
    nodeWrites.length,
    2,
    "one write per character of the 2-char string",
  );
  for (const w of nodeWrites) {
    assertEquals(
      w.name,
      undefined,
      "a character has no .name — writeResource(name) is undefined",
    );
    assertEquals(w.payload.type, "unknown");
    assertEquals(w.payload.addresses, "");
  }
});

Deno.test("pin: a non-JSON linstor payload makes listNodes throw a SyntaxError", async () => {
  const stub = installCmdStub([{
    success: true,
    stdout: "not-json",
    stderr: "",
  }]);
  const { ctx } = makeCtx();
  try {
    await assertRejects(() => run("listNodes", {}, ctx), SyntaxError);
  } finally {
    stub.restore();
  }
});

Deno.test("pin: an OBJECT-shaped linstor payload makes listStoragePools throw — `for..of` over a non-iterable object", async () => {
  const stub = installCmdStub([{ success: true, stdout: "{}", stderr: "" }]);
  const { ctx } = makeCtx();
  try {
    await assertRejects(() => run("listStoragePools", {}, ctx), TypeError);
  } finally {
    stub.restore();
  }
});

Deno.test("pin: a STRING-shaped linstor payload makes listStoragePools iterate CHARACTERS — silent per-character garbage writes", async () => {
  const stub = installCmdStub([
    { success: true, stdout: JSON.stringify("xy"), stderr: "" },
  ]);
  const { ctx, written } = makeCtx();
  try {
    await run("listStoragePools", {}, ctx);
  } finally {
    stub.restore();
  }
  const poolWrites = written.filter((w) => w.spec === "storagePool");
  assertEquals(poolWrites.length, 2);
  for (const w of poolWrites) {
    assertEquals(
      w.name,
      "undefined-undefined",
      "the `${node_name}-${stor_pool_name}` template on two undefined properties",
    );
    assertEquals(w.payload.driver, "unknown");
    assertEquals(w.payload.free, "unknown");
    assertEquals(w.payload.capacity, "unknown");
    assertEquals(
      w.payload.state,
      "ok",
      "a character has no `.reports` -> state:ok",
    );
  }
});

Deno.test("pin: a non-JSON linstor payload makes listStoragePools throw a SyntaxError", async () => {
  const stub = installCmdStub([{
    success: true,
    stdout: "not-json",
    stderr: "",
  }]);
  const { ctx } = makeCtx();
  try {
    await assertRejects(() => run("listStoragePools", {}, ctx), SyntaxError);
  } finally {
    stub.restore();
  }
});

// ---------------------------------------------------------------------------
// Retry exhaustion under FakeTime — the reachable in-loop throw, 4 invocations
// ---------------------------------------------------------------------------

Deno.test("RETRY: 4 consecutive transient failures exhaust maxRetries — throws the REACHABLE in-loop error after exactly 4 Command invocations", async () => {
  using time = new FakeTime();
  const stub = installCmdStub([
    { success: false, stdout: "", stderr: "connection refused" },
    { success: false, stdout: "", stderr: "connection refused" },
    { success: false, stdout: "", stderr: "connection refused" },
    { success: false, stdout: "", stderr: "connection refused" },
  ]);
  const { ctx } = makeCtx();
  let caught: Error | undefined;
  try {
    const p = run("listNodes", {}, ctx).catch((e) => {
      caught = e;
    });
    // Three sequential 5000ms delays are scheduled ONE AT A TIME (a new
    // setTimeout is only created after the previous one resolves and the
    // next attempt fails) — a single tickAsync call is advanced three times
    // in a row to walk the chain, rather than one big tick.
    await time.tickAsync(5000);
    await time.tickAsync(5000);
    await time.tickAsync(5000);
    await p;
  } finally {
    stub.restore();
  }
  assertEquals(
    stub.invocations.length,
    4,
    "3 retries + the exhausting 4th attempt",
  );
  assert(caught instanceof Error);
  assertEquals(
    caught.message,
    "linstor node list --output-version=v1 failed: connection refused",
    "the REACHABLE in-loop throw fires at attempt=3 (attempt<maxRetries is false) — " +
      "the trailing 'failed after N attempts' throw AFTER the loop is unreachable dead code",
  );
});

Deno.test("RETRY: a NON-transient failure never retries — throws on the first invocation with no delay scheduled", async () => {
  using time = new FakeTime();
  const startedAt = time.now;
  const stub = installCmdStub([
    { success: false, stdout: "", stderr: "Error: unauthorized" },
  ]);
  const { ctx } = makeCtx();
  try {
    await assertRejects(() => run("listNodes", {}, ctx));
  } finally {
    stub.restore();
  }
  assertEquals(stub.invocations.length, 1);
  assertEquals(
    time.now,
    startedAt,
    "no retry delay was ever scheduled or awaited — the fake clock never advanced",
  );
});

// ---------------------------------------------------------------------------
// Fixtures-secret-scan — k8s/kubeconfig-shaped patterns, NOT porkbun's pk1_/sk1_
// ---------------------------------------------------------------------------
// cozystack-linstor has no API key; its secret surface is kubeconfig/LINSTOR
// material (PEM key blocks, kubeconfig cert/token fields, JWT/bearer tokens,
// and real (non-doc, non-private) IP addresses). A synthetic-value allowlist
// keeps our OWN intentional RFC-5737 addresses and node names from
// self-flagging.

const SECRET_PATTERNS: Array<{ name: string; re: RegExp }> = [
  {
    name: "PEM private/EC key header",
    re: /-----BEGIN (RSA |EC )?PRIVATE KEY-----/,
  },
  {
    name: "kubeconfig client-certificate-data key",
    re: /\bclient-certificate-data\b/,
  },
  { name: "kubeconfig client-key-data key", re: /\bclient-key-data\b/ },
  {
    name: "kubeconfig certificate-authority-data key",
    re: /\bcertificate-authority-data\b/,
  },
  { name: "bearer/token keyword", re: /\b(bearer|token)\b/i },
  { name: "JWT prefix (eyJ...)", re: /\beyJ[A-Za-z0-9_-]{10,}/ },
];

/** RFC 5737 documentation ranges (TEST-NET-1/2/3) — safe, synthetic. Checked
 * to the exact /24 (a.b.c), not merely the first two octets. */
function inRfc5737(a: number, b: number, c: number): boolean {
  return (
    (a === 192 && b === 0 && c === 2) || // TEST-NET-1
    (a === 198 && b === 51 && c === 100) || // TEST-NET-2
    (a === 203 && b === 0 && c === 113) // TEST-NET-3
  );
}

/** RFC 1918 private ranges — safe (never a real routable/public address). */
function inRfc1918(a: number, b: number): boolean {
  return a === 10 || (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168);
}

const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/** True iff `str` looks like an IPv4 address that is NEITHER an RFC 5737
 * documentation address NOR an RFC 1918 private address — i.e. it could be a
 * real, routable address leaked from a live cluster. */
function isSuspiciousIp(str: string): boolean {
  const m = IPV4_RE.exec(str);
  if (!m) return false;
  const [a, b, c] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (a > 255 || b > 255 || c > 255) return false;
  return !inRfc5737(a, b, c) && !inRfc1918(a, b);
}

/** Exact-string synthetic values this corpus intentionally uses, which must
 * never trip the scan even though they are plain identifiers. */
const ALLOWED_SYNTHETIC_VALUES = new Set([
  "worker-0",
  "worker-1",
  "worker-2",
  "default",
  "eth1",
  "data",
  "legacy",
  "cozy-linstor",
  "192.0.2.10",
  "192.0.2.11",
  "192.0.2.21",
]);

/** Recursively collect every string leaf value in a parsed JSON structure. */
function collectStrings(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") {
    out.push(value);
  } else if (Array.isArray(value)) {
    for (const v of value) collectStrings(v, out);
  } else if (value !== null && typeof value === "object") {
    for (const v of Object.values(value as Record<string, unknown>)) {
      collectStrings(v, out);
    }
  }
  return out;
}

// Every committed fixture MUST be added here — the scan reads statically
// imported objects (no directory glob), keeping the default test task
// --allow-read-free.
const FIXTURES: Record<string, unknown> = {
  "node-list.json": nodeList,
  "storage-pool-list.json": storagePoolList,
  "deploy-ready.json": deployReady,
  "deploy-notready.json": deployNotReady,
  "physical-storage-list.json": physicalStorageList,
};

Deno.test("fixtures-secret-scan: no committed fixture contains a k8s/kubeconfig-secret-shaped string", () => {
  const violations: string[] = [];
  for (const [file, data] of Object.entries(FIXTURES)) {
    for (const str of collectStrings(data)) {
      if (ALLOWED_SYNTHETIC_VALUES.has(str)) continue;
      for (const { name, re } of SECRET_PATTERNS) {
        if (re.test(str)) {
          violations.push(`${file}: value "${str}" matched ${name}`);
        }
      }
      if (isSuspiciousIp(str)) {
        violations.push(
          `${file}: value "${str}" looks like a real IP (not RFC 5737 / RFC 1918)`,
        );
      }
    }
  }
  assertEquals(
    violations,
    [],
    `secret-shaped content found in committed fixtures:\n${
      violations.join("\n")
    }`,
  );
});

Deno.test("fixtures-secret-scan: sanity — the scanner actually detects an injected k8s secret shape (PEM + JWT)", () => {
  const violations: string[] = [];
  const poisoned = {
    key:
      "-----BEGIN PRIVATE KEY-----\nMIIFAKEnotarealkeyDATA\n-----END PRIVATE KEY-----",
    saToken:
      "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJmYWtlIn0.fakefakefakefakefakefake",
  };
  for (const str of collectStrings(poisoned)) {
    for (const { re } of SECRET_PATTERNS) {
      if (re.test(str)) violations.push(str);
    }
  }
  assert(
    violations.length > 0,
    "sanity check: scanner must flag a real PEM/JWT shape",
  );
});

Deno.test("fixtures-secret-scan: sanity — the IP checker flags a real (non-doc, non-private) address like a public resolver", () => {
  assert(
    isSuspiciousIp("8.8.8.8"),
    "sanity check: a well-known public IP must be flagged as suspicious",
  );
  assert(
    !isSuspiciousIp("192.0.2.10"),
    "an RFC 5737 documentation address must NOT be flagged",
  );
  assert(
    !isSuspiciousIp("10.0.0.5"),
    "an RFC 1918 private address must NOT be flagged",
  );
});
