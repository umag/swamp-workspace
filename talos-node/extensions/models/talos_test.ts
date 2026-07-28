/**
 * Contract-fixture suite: pins the CONCRETE talosctl wire shape from
 * talos-node/fixtures/*.json directly — the version --json keyset, the
 * services/etcd-members COLUMN layout the tabular parsers depend on, and the
 * kubeconfig verbatim-passthrough/sensitive-output contract. Independent of
 * any live network/subprocess call: every fixture is a synthetic
 * {success, stdout, stderr} envelope fed through a stubbed `Deno.Command`
 * (see STANDARD.md's contract-fixture role).
 *
 * talos.ts is UNMODIFIED by this change — every test here is a
 * characterization test that pins the model's current, already-shipped
 * behavior. All fixtures are PURE doc/help-derived synthetic data — see
 * fixtures/PROVENANCE.md. No real talosctl process is ever spawned.
 */
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import { model } from "./talos.ts";
import version from "../../fixtures/version.json" with { type: "json" };
import services from "../../fixtures/services.json" with { type: "json" };
import etcdMembers from "../../fixtures/etcd-members.json" with {
  type: "json",
};
import kubeconfig from "../../fixtures/kubeconfig.json" with { type: "json" };
import health from "../../fixtures/health.json" with { type: "json" };
import applyConfig from "../../fixtures/apply-config.json" with {
  type: "json",
};
import errorFixture from "../../fixtures/error.json" with { type: "json" };

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const GLOBAL_ARGS = {
  endpoint: "192.0.2.10",
  insecure: false,
};

type Written = {
  spec: string;
  name: string;
  payload: Record<string, unknown>;
};

function makeCtx(globalArgs: Record<string, unknown> = GLOBAL_ARGS) {
  const written: Written[] = [];
  return {
    written,
    ctx: {
      globalArgs,
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

type CommandEnvelope = { success: boolean; stdout: string; stderr: string };
type CommandRecording = { cmd: string; args: string[] };

/** Reassign the global Deno.Command to a fake that records argv and returns
 * a canned {success, stdout, stderr} envelope (decoded/encoded exactly like
 * the real subprocess boundary). Restored in `finally` so a thrown assertion
 * cannot leak the stub into a sibling test file's isolate. */
function withCommandStub(
  handler: (
    call: CommandRecording,
    callIndex: number,
  ) => CommandEnvelope | Promise<CommandEnvelope>,
  fn: (calls: CommandRecording[]) => Promise<unknown>,
) {
  const denoRecord = Deno as unknown as Record<string, unknown>;
  const original = denoRecord.Command;
  const calls: CommandRecording[] = [];
  let index = 0;
  class FakeCommand {
    #recording: CommandRecording;
    constructor(cmd: string, options: { args?: string[] }) {
      this.#recording = { cmd, args: options.args ?? [] };
    }
    output(): Promise<
      { success: boolean; stdout: Uint8Array; stderr: Uint8Array }
    > {
      calls.push(this.#recording);
      const i = index++;
      return Promise.resolve(handler(this.#recording, i)).then((r) => ({
        success: r.success,
        stdout: new TextEncoder().encode(r.stdout),
        stderr: new TextEncoder().encode(r.stderr),
      }));
    }
  }
  denoRecord.Command = FakeCommand;
  return fn(calls).finally(() => {
    denoRecord.Command = original;
  });
}

function withOneCommand(
  envelope: CommandEnvelope,
  fn: (calls: CommandRecording[]) => Promise<unknown>,
) {
  return withCommandStub(() => envelope, fn);
}

// ---------------------------------------------------------------------------
// version.json contract
// ---------------------------------------------------------------------------

Deno.test("contract: version.json — tag/sha/arch/platform keyset from the nested version --json body", async () => {
  const { ctx, written } = makeCtx();
  await withOneCommand(version, () => run("version", {}, ctx));
  const res = written.find((w) => w.spec === "version")!;
  const parsed = JSON.parse(version.stdout);
  assertEquals(res.name, "main");
  assertEquals(res.payload.node, GLOBAL_ARGS.endpoint);
  assertEquals(res.payload.tag, parsed.version.tag);
  assertEquals(res.payload.sha, parsed.version.sha);
  assertEquals(res.payload.arch, parsed.version.arch);
  assertEquals(res.payload.platform, parsed.platform.name);
  assert(typeof res.payload.timestamp === "string");
});

// ---------------------------------------------------------------------------
// services.json contract — the tabular COLUMN layout the parser depends on
// ---------------------------------------------------------------------------

Deno.test("contract: services.json — every documented row becomes a service resource named by SERVICE (column 2)", async () => {
  const { ctx, written } = makeCtx();
  await withOneCommand(services, () => run("services", {}, ctx));
  const rows = written.filter((w) => w.spec === "service");
  const lines = services.stdout.trim().split("\n");
  assertEquals(rows.length, lines.length - 1, "one resource per data row");
  assertEquals(rows.map((r) => r.name), [
    "apid",
    "containerd",
    "cri",
    "etcd",
    "kubelet",
    "machined",
    "trustd",
  ]);
  for (const r of rows) {
    assertEquals(r.payload.id, r.name);
    assertEquals(r.payload.state, "Running");
    assertEquals(r.payload.health, "OK");
    assert(typeof r.payload.timestamp === "string");
  }
});

// ---------------------------------------------------------------------------
// etcd-members.json contract
// ---------------------------------------------------------------------------

Deno.test("contract: etcd-members.json — hostname/id/peerUrls/clientUrls/isLearner from the documented 6-column layout", async () => {
  const { ctx, written } = makeCtx();
  await withOneCommand(etcdMembers, () => run("etcdMembers", {}, ctx));
  const rows = written.filter((w) => w.spec === "etcdMember");
  assertEquals(rows.length, 3);
  assertEquals(rows.map((r) => r.name), ["cp1", "cp2", "cp3"]);
  assertEquals(rows[0].payload.id, "634a1dccd6e0d1e5");
  assertEquals(rows[0].payload.peerUrls, ["https://192.0.2.10:2380"]);
  assertEquals(rows[0].payload.clientUrls, ["https://192.0.2.10:2379"]);
  assertEquals(rows[0].payload.isLearner, false);
  assertEquals(
    rows[2].payload.isLearner,
    true,
    "the LEARNER column literal string 'true' -> boolean true",
  );
});

// ---------------------------------------------------------------------------
// kubeconfig.json contract — verbatim passthrough + sensitive marking
// ---------------------------------------------------------------------------

Deno.test("contract: kubeconfig.json — stdout stored VERBATIM as the kubeconfig field", async () => {
  const { ctx, written } = makeCtx();
  await withOneCommand(kubeconfig, () => run("kubeconfig", {}, ctx));
  const res = written.find((w) => w.spec === "kubeconfig")!;
  assertEquals(res.name, "main");
  assertEquals(res.payload.kubeconfig, kubeconfig.stdout);
  assert(typeof res.payload.timestamp === "string");
});

Deno.test("contract: the kubeconfig resource spec is marked sensitiveOutput in the model schema", () => {
  const resources = model.resources as Record<
    string,
    { sensitiveOutput?: boolean }
  >;
  assertEquals(resources.kubeconfig.sensitiveOutput, true);
});

// ---------------------------------------------------------------------------
// health.json contract
// ---------------------------------------------------------------------------

Deno.test("contract: health.json — non-empty stdout becomes the result message verbatim (trimmed)", async () => {
  const { ctx, written } = makeCtx();
  await withOneCommand(health, () => run("health", {}, ctx));
  const res = written.find((w) => w.spec === "result")!;
  assertEquals(res.name, "health");
  assertEquals(res.payload.success, true);
  assertEquals(res.payload.message, health.stdout.trim());
});

// ---------------------------------------------------------------------------
// apply-config.json contract — the stderr-warnings branch
// ---------------------------------------------------------------------------

Deno.test("contract: apply-config.json — non-empty stderr becomes a non-empty `warnings` array of trimmed lines", async () => {
  const { ctx, written } = makeCtx();
  await withOneCommand(
    applyConfig,
    () =>
      run("applyConfig", {
        configFile: "/fake/controlplane.yaml",
        mode: "auto",
      }, ctx),
  );
  const res = written.find((w) => w.spec === "result")!;
  assertEquals(res.name, "applyConfig");
  assertEquals(res.payload.success, true);
  assertEquals(
    res.payload.message,
    `Config applied to ${GLOBAL_ARGS.endpoint} (mode=auto)`,
  );
  const expectedWarnings = applyConfig.stderr
    .split("\n")
    .filter((l) => l.trim());
  assertEquals(res.payload.warnings, expectedWarnings);
  assert((res.payload.warnings as string[]).length > 0);
});

// ---------------------------------------------------------------------------
// error.json contract — a failed talosctl invocation throws stderr verbatim
// ---------------------------------------------------------------------------

Deno.test("contract: error.json — a non-success talosctl exit throws `talosctl <cmd[0]> failed: <stderr>`", async () => {
  const { ctx } = makeCtx();
  await withOneCommand(errorFixture, async () => {
    const err = await assertRejects(
      () =>
        run("applyConfig", {
          configFile: "/fake/controlplane.yaml",
          mode: "auto",
        }, ctx),
      Error,
    );
    assertEquals(
      (err as Error).message,
      `talosctl apply-config failed: ${errorFixture.stderr}`,
    );
  });
});
