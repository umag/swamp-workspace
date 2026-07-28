/**
 * Property-based tests (fast-check) for @magistr/talos-node.
 *
 * talos.ts exports no pure helpers — every property here is observed by
 * driving `model.methods.<m>.execute()` against a stubbed `Deno.Command` and
 * reading back the captured argv / written resource, per the approved plan.
 *
 * Properties:
 *  (a) argv-builder determinism + injectivity for applyConfig, stated MODULO
 *      the documented normalization: restricted to the canonical subset where
 *      the GLOBAL `insecure` is fixed to `false`, since `args.insecure` stops
 *      mattering once the global default is already `true` (round-1 finding
 *      — naive injectivity is FALSE over the raw input space). The collapse
 *      itself is pinned as a named example, mirroring porkbun's round-1/
 *      round-2 findings.
 *  (b) services/etcdMembers tabular-parser round-trip — every well-formed
 *      row survives parsing with its fields preserved, in order; any row
 *      with fewer than the required whitespace-split columns is always
 *      skipped, regardless of its content.
 *
 * talos.ts is UNMODIFIED by this change; every property PINS existing,
 * already-shipped behavior.
 */
import { assertEquals } from "jsr:@std/assert@1";
import fc from "npm:fast-check@4.8.0";
import { model } from "./talos.ts";

// Property iteration count — overridable for the nightly soak via
// FC_NUM_RUNS (e.g. FC_NUM_RUNS=10000 deno task test:soak).
const ENV_RUNS = Deno.env.get("FC_NUM_RUNS");
const NIGHT = (n: number): number => (ENV_RUNS ? Number(ENV_RUNS) : n);
const FC_RUNS = { numRuns: NIGHT(200) };

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const ENDPOINT = "192.0.2.10";

type Written = {
  spec: string;
  name: string;
  payload: Record<string, unknown>;
};

function makeCtx(globalArgs: Record<string, unknown>) {
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

function withCommandStub(
  handler: (
    call: CommandRecording,
    callIndex: number,
  ) => CommandEnvelope | Promise<CommandEnvelope>,
  fn: (calls: CommandRecording[]) => Promise<void>,
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
  fn: (calls: CommandRecording[]) => Promise<void>,
) {
  return withCommandStub(() => envelope, fn);
}

const OK = (stdout = ""): CommandEnvelope => ({
  success: true,
  stdout,
  stderr: "",
});

// ---------------------------------------------------------------------------
// (a) applyConfig argv-builder determinism + injectivity, MODULO the
//     documented insecure-override normalization
// ---------------------------------------------------------------------------

async function applyConfigArgvFor(
  input: Record<string, unknown>,
  globalInsecure: boolean,
): Promise<string[]> {
  const { ctx } = makeCtx({ endpoint: ENDPOINT, insecure: globalInsecure });
  let argv: string[] = [];
  await withOneCommand(OK(), async (calls) => {
    await run("applyConfig", input, ctx);
    argv = calls[0].args;
  });
  return argv;
}

// Restricted to the CANONICAL subset: global `insecure` fixed to `false`.
// Within this subset, `args.insecure` genuinely and injectively controls
// whether `--insecure` appears — the collapse only occurs when the global
// default is already `true` (pinned separately below).
const arbCanonicalApplyConfigInput = fc.record({
  configFile: fc.stringMatching(/^[a-zA-Z0-9_.\/-]{1,40}$/),
  mode: fc.constantFrom("auto", "reboot", "no-reboot", "staged"),
  insecure: fc.boolean(),
});

function canonicalSignature(input: Record<string, unknown>): string {
  return JSON.stringify([input.configFile, input.mode, input.insecure]);
}

Deno.test("property: applyConfig's argv is deterministic — same canonical input -> same argv", async () => {
  await fc.assert(
    fc.asyncProperty(arbCanonicalApplyConfigInput, async (input) => {
      const a = await applyConfigArgvFor(input, false);
      const b = await applyConfigArgvFor(input, false);
      return JSON.stringify(a) === JSON.stringify(b);
    }),
    { numRuns: NIGHT(100) },
  );
});

Deno.test("property: applyConfig's argv is INJECTIVE over the canonical (global insecure=false) input subset", async () => {
  await fc.assert(
    fc.asyncProperty(
      arbCanonicalApplyConfigInput,
      arbCanonicalApplyConfigInput,
      async (a, b) => {
        const sigA = canonicalSignature(a);
        const sigB = canonicalSignature(b);
        const argvA = JSON.stringify(await applyConfigArgvFor(a, false));
        const argvB = JSON.stringify(await applyConfigArgvFor(b, false));
        return sigA === sigB ? argvA === argvB : argvA !== argvB;
      },
    ),
    { numRuns: NIGHT(300) },
  );
});

Deno.test("collapse: when the GLOBAL insecure is already true, applyConfig's args.insecure true vs false produce the IDENTICAL argv (both include --insecure)", async () => {
  // This is the round-1 review finding pinned as a named example: naive
  // injectivity is FALSE over the raw input space because
  // `args.insecure ? {...globalArgs, insecure:true} : globalArgs` makes
  // args.insecure a no-op once the global default is already true.
  const withOverrideTrue = await applyConfigArgvFor(
    { configFile: "/fake/x.yaml", mode: "auto", insecure: true },
    true,
  );
  const withOverrideFalse = await applyConfigArgvFor(
    { configFile: "/fake/x.yaml", mode: "auto", insecure: false },
    true,
  );
  assertEquals(withOverrideTrue, withOverrideFalse);
  assertEquals(withOverrideTrue.includes("--insecure"), true);
});

// ---------------------------------------------------------------------------
// (b) services tabular-parser round-trip
// ---------------------------------------------------------------------------

const arbToken = fc.stringMatching(/^[a-zA-Z0-9]{1,12}$/);

const arbServiceRow = fc.record({
  service: arbToken,
  state: fc.constantFrom("Running", "Stopped", "Waiting", "Failed"),
  health: fc.constantFrom("OK", "Fail", "Unknown"),
});

function servicesTableFor(
  rows: Array<{ service: string; state: string; health: string }>,
): string {
  const header = "NODE SERVICE STATE HEALTH";
  const lines = rows.map((r) =>
    `${ENDPOINT}   ${r.service}   ${r.state}   ${r.health}`
  );
  return [header, ...lines].join("\n") + "\n";
}

Deno.test("property: services round-trips every well-formed row, in order, with id/state/health preserved", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.array(arbServiceRow, { minLength: 0, maxLength: 15 }),
      async (rows) => {
        const { ctx, written } = makeCtx({ endpoint: ENDPOINT });
        await withOneCommand(OK(servicesTableFor(rows)), async () => {
          await run("services", {}, ctx);
        });
        const got = written.filter((w) => w.spec === "service");
        if (got.length !== rows.length) return false;
        return got.every((w, i) =>
          w.name === rows[i].service &&
          w.payload.state === rows[i].state &&
          w.payload.health === rows[i].health
        );
      },
    ),
    FC_RUNS,
  );
});

Deno.test("property: a services row with fewer than 4 whitespace tokens is ALWAYS skipped, regardless of content", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.array(arbToken, { minLength: 0, maxLength: 3 }),
      async (tokens) => {
        const row = tokens.join("   ");
        const table = `NODE SERVICE STATE HEALTH\n${row}\n`;
        const { ctx, written } = makeCtx({ endpoint: ENDPOINT });
        await withOneCommand(OK(table), async () => {
          await run("services", {}, ctx);
        });
        return written.filter((w) => w.spec === "service").length === 0;
      },
    ),
    FC_RUNS,
  );
});

// ---------------------------------------------------------------------------
// (b) etcdMembers tabular-parser round-trip
// ---------------------------------------------------------------------------

const arbEtcdRow = fc.record({
  id: arbToken,
  hostname: arbToken,
  peerUrl: fc.stringMatching(/^https:\/\/[a-z0-9.]{1,20}:2380$/),
  clientUrl: fc.stringMatching(/^https:\/\/[a-z0-9.]{1,20}:2379$/),
  isLearner: fc.boolean(),
});

function etcdTableFor(
  rows: Array<
    {
      id: string;
      hostname: string;
      peerUrl: string;
      clientUrl: string;
      isLearner: boolean;
    }
  >,
): string {
  const header = "NODE ID HOSTNAME PEER CLIENT LEARNER";
  const lines = rows.map((r) =>
    `${ENDPOINT}   ${r.id}   ${r.hostname}   ${r.peerUrl}   ${r.clientUrl}   ${r.isLearner}`
  );
  return [header, ...lines].join("\n") + "\n";
}

Deno.test("property: etcdMembers round-trips every well-formed row with id/peerUrls/clientUrls/isLearner preserved", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.array(arbEtcdRow, { minLength: 0, maxLength: 10 }),
      async (rows) => {
        const { ctx, written } = makeCtx({ endpoint: ENDPOINT });
        await withOneCommand(OK(etcdTableFor(rows)), async () => {
          await run("etcdMembers", {}, ctx);
        });
        const got = written.filter((w) => w.spec === "etcdMember");
        if (got.length !== rows.length) return false;
        return got.every((w, i) =>
          w.name === rows[i].hostname &&
          w.payload.id === rows[i].id &&
          JSON.stringify(w.payload.peerUrls) ===
            JSON.stringify([rows[i].peerUrl]) &&
          JSON.stringify(w.payload.clientUrls) ===
            JSON.stringify([rows[i].clientUrl]) &&
          w.payload.isLearner === rows[i].isLearner
        );
      },
    ),
    FC_RUNS,
  );
});

Deno.test("property: an etcd-members row with fewer than 6 whitespace tokens is ALWAYS skipped, regardless of content", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.array(arbToken, { minLength: 0, maxLength: 5 }),
      async (tokens) => {
        const row = tokens.join("   ");
        const table = `NODE ID HOSTNAME PEER CLIENT LEARNER\n${row}\n`;
        const { ctx, written } = makeCtx({ endpoint: ENDPOINT });
        await withOneCommand(OK(table), async () => {
          await run("etcdMembers", {}, ctx);
        });
        return written.filter((w) => w.spec === "etcdMember").length === 0;
      },
    ),
    FC_RUNS,
  );
});
