/**
 * Property-based tests (fast-check) for @magistr/observability/agent.
 *
 * observability_agent.ts is UNMODIFIED — every property here is observed by
 * driving `model.methods.<m>.execute()` against a stubbed
 * `globalThis.Deno.Command` and reading back the captured argv / captured
 * (base64-decoded, where applicable) stdin script / written resource, per
 * the approved plan. Named invariants:
 *
 *  (a) parseKv round-trip/injectivity — install's NODE/BLACKBOX/VECTOR
 *      values survive verbatim through `KEY=value` stdout lines for
 *      arbitrary safe values (including values that themselves contain an
 *      embedded `=`, since parseKv only splits on the FIRST `=`).
 *  (b) ssh-argv determinism + injectivity of (sshHost, sshUser, sshPort) ->
 *      the `user@host` argv element and the `-p <port>` argv element.
 *  (c) bootDropin invariant — StartLimitIntervalSec=0 + a Restart= stanza
 *      are ALWAYS present; the After=/Wants= wait-unit lines are present
 *      IFF bindWaitUnit is set.
 *  (d) inventory's `===SECTION===` parser round-trips an arbitrary
 *      well-formed (services, listeners, processes) triple exactly.
 *
 * No FakeTime/setTimeout stub is needed anywhere: the only "sleep" (`sleep
 * 2`) lives INSIDE the remote bash script STRING, never as a local JS
 * timer; the only nondeterminism (`new Date().toISOString()`) is asserted
 * as `typeof === "string"` elsewhere (contract-fixture suite), never
 * time-traveled here.
 */
import fc from "npm:fast-check@4.8.0";
import { assert } from "jsr:@std/assert@1";
import { model } from "./observability_agent.ts";

// Property iteration count — overridable for the nightly soak via
// FC_NUM_RUNS (e.g. FC_NUM_RUNS=10000 deno task test:soak).
const ENV_RUNS = Deno.env.get("FC_NUM_RUNS");
const NIGHT = (n: number): number => (ENV_RUNS ? Number(ENV_RUNS) : n);
const FC_RUNS = { numRuns: NIGHT(200) };

// ---------------------------------------------------------------------------
// Harness (duplicated per this repo's suite convention)
// ---------------------------------------------------------------------------

type Written = {
  spec: string;
  name: string;
  payload: Record<string, unknown>;
};

function gArgs(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return model.globalArguments.parse({
    sshHost: "host.example",
    ...overrides,
  }) as Record<string, unknown>;
}

function makeCtx(globalArgOverrides: Record<string, unknown> = {}) {
  const written: Written[] = [];
  return {
    written,
    ctx: {
      globalArgs: gArgs(globalArgOverrides),
      writeResource: (spec: string, name: string, payload: unknown) => {
        written.push({
          spec,
          name,
          payload: payload as Record<string, unknown>,
        });
        return Promise.resolve({ spec, name });
      },
    },
  };
}

type MethodMap = Record<string, {
  arguments: { parse: (a: unknown) => unknown };
  execute: (a: unknown, c: unknown) => Promise<unknown>;
}>;

function run(name: string, args: Record<string, unknown>, ctx: unknown) {
  const method = (model.methods as MethodMap)[name];
  assert(method, `method ${name} must exist on the model`);
  return method.execute(method.arguments.parse(args), ctx);
}

interface CapturedCall {
  binary: string;
  args: string[];
  stdin: string;
}

interface CommandResult {
  success: boolean;
  stdout: string;
  stderr: string;
}

function encodeOutput(r: CommandResult) {
  return {
    success: r.success,
    code: r.success ? 0 : 1,
    signal: null,
    stdout: new TextEncoder().encode(r.stdout),
    stderr: new TextEncoder().encode(r.stderr),
  };
}

function withCommandStub(
  result: CommandResult,
  fn: (calls: CapturedCall[]) => Promise<void>,
): Promise<void> {
  const calls: CapturedCall[] = [];
  const original = Deno.Command;

  class FakeCommand {
    #call: CapturedCall;
    constructor(binary: string, opts: Record<string, unknown> = {}) {
      this.#call = {
        binary,
        args: (opts.args as string[] | undefined) ?? [],
        stdin: "",
      };
      calls.push(this.#call);
    }
    spawn() {
      const call = this.#call;
      return {
        stdin: {
          getWriter: () => ({
            write: (chunk: Uint8Array) => {
              call.stdin += new TextDecoder().decode(chunk);
              return Promise.resolve();
            },
            close: () => Promise.resolve(),
          }),
        },
        output: () => Promise.resolve(encodeOutput(result)),
      };
    }
    output() {
      return Promise.resolve(encodeOutput(result));
    }
  }

  (Deno as unknown as { Command: unknown }).Command = FakeCommand;
  return fn(calls).finally(() => {
    (Deno as unknown as { Command: unknown }).Command = original;
  });
}

function extractRemoteFile(script: string, path: string): string {
  const escapedPath = path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(
    `echo '([A-Za-z0-9+/=]+)' \\| base64 -d > '${escapedPath}'`,
  );
  const m = script.match(re);
  if (!m) throw new Error(`expected a base64 write to ${path}`);
  return atob(m[1]);
}

// ---------------------------------------------------------------------------
// (a) parseKv round-trip/injectivity — install's NODE value
// ---------------------------------------------------------------------------

// Printable, no whitespace (so parseKv's `.trim()` is a no-op) and no
// newline (so the value can never split into a second stdout line); MAY
// contain "=" (the interesting round-trip case — parseKv splits only on the
// FIRST "=" in a line).
const arbKvValue = fc.stringMatching(/^[A-Za-z0-9._:\/=+-]{1,30}$/);

async function installNodeValueFor(value: string): Promise<unknown> {
  const { ctx, written } = makeCtx();
  await withCommandStub(
    {
      success: true,
      stdout: `NODE=${value}\nBLACKBOX=irrelevant\nVECTOR=irrelevant\n`,
      stderr: "",
    },
    async () => {
      await run("install", {}, ctx);
    },
  );
  return written.find((w) => w.spec === "install")!.payload.nodeExporter;
}

Deno.test("property: install's NODE value round-trips through parseKv verbatim for arbitrary safe values (including values containing '=')", async () => {
  await fc.assert(
    fc.asyncProperty(arbKvValue, async (value) => {
      const got = await installNodeValueFor(value);
      return got === value;
    }),
    FC_RUNS,
  );
});

Deno.test("property: parseKv's per-key extraction is injective — distinct NODE values produce distinct results (corollary of the round-trip above)", async () => {
  await fc.assert(
    fc.asyncProperty(arbKvValue, arbKvValue, async (a, b) => {
      const gotA = await installNodeValueFor(a);
      const gotB = await installNodeValueFor(b);
      return a === b ? gotA === gotB : gotA !== gotB;
    }),
    FC_RUNS,
  );
});

// ---------------------------------------------------------------------------
// (b) ssh-argv determinism + injectivity of (sshHost, sshUser, sshPort)
// ---------------------------------------------------------------------------

// Alphabets deliberately EXCLUDE "@" from both sshHost and sshUser, which is
// what makes the `${sshUser}@${sshHost}` join provably unambiguous (no
// cross-field collision is possible when neither field can itself contain
// the separator character).
const arbSshTriple = fc.record({
  sshHost: fc.stringMatching(/^[a-zA-Z0-9.-]{1,20}$/),
  sshUser: fc.stringMatching(/^[a-zA-Z0-9_-]{1,15}$/),
  sshPort: fc.integer({ min: 1, max: 65535 }),
});

async function installArgvFor(
  triple: { sshHost: string; sshUser: string; sshPort: number },
): Promise<string[]> {
  const { ctx } = makeCtx(triple);
  let argv: string[] = [];
  await withCommandStub(
    {
      success: true,
      stdout: "NODE=1.0\nBLACKBOX=1.0\nVECTOR=1.0\n",
      stderr: "",
    },
    async (calls) => {
      await run("install", {}, ctx);
      argv = calls[0].args;
    },
  );
  return argv;
}

Deno.test("property: ssh argv's -p <port> and user@host elements are injective over (sshHost, sshUser, sshPort)", async () => {
  await fc.assert(
    fc.asyncProperty(arbSshTriple, arbSshTriple, async (a, b) => {
      const argvA = await installArgvFor(a);
      const argvB = await installArgvFor(b);
      const same = a.sshHost === b.sshHost && a.sshUser === b.sshUser &&
        a.sshPort === b.sshPort;
      const slotsEqual = argvA[7] === argvB[7] && argvA[8] === argvB[8];
      return same ? slotsEqual : !slotsEqual;
    }),
    FC_RUNS,
  );
});

Deno.test("property: ssh argv's port/user@host slots are a DETERMINISTIC, exact function of (sshHost, sshUser, sshPort)", async () => {
  await fc.assert(
    fc.asyncProperty(arbSshTriple, async (triple) => {
      const argv = await installArgvFor(triple);
      return argv[7] === String(triple.sshPort) &&
        argv[8] === `${triple.sshUser}@${triple.sshHost}`;
    }),
    FC_RUNS,
  );
});

// ---------------------------------------------------------------------------
// (c) bootDropin invariant
// ---------------------------------------------------------------------------

const arbBindWaitUnit = fc.option(
  fc.stringMatching(/^[a-zA-Z0-9@.-]{1,30}$/),
  { nil: undefined },
);

async function bootDropinFor(
  bindWaitUnit: string | undefined,
): Promise<string> {
  const overrides: Record<string, unknown> = {};
  if (bindWaitUnit !== undefined) overrides.bindWaitUnit = bindWaitUnit;
  const { ctx } = makeCtx(overrides);
  let script = "";
  await withCommandStub(
    {
      success: true,
      stdout: "NODE=active\nBLACKBOX=active\nVECTOR=skipped\n",
      stderr: "",
    },
    async (calls) => {
      await run("configure", {}, ctx);
      script = calls[0].stdin;
    },
  );
  return extractRemoteFile(
    script,
    "/etc/systemd/system/prometheus-node-exporter.service.d/10-boot.conf",
  );
}

Deno.test("property: bootDropin ALWAYS carries StartLimitIntervalSec=0 + Restart=on-failure; carries After=/Wants= IFF bindWaitUnit is set", async () => {
  await fc.assert(
    fc.asyncProperty(arbBindWaitUnit, async (bindWaitUnit) => {
      const unit = await bootDropinFor(bindWaitUnit);
      const hasInvariants = unit.includes("StartLimitIntervalSec=0") &&
        unit.includes("Restart=on-failure") &&
        unit.includes("RestartSec=5");
      const hasWait = unit.includes("After=") && unit.includes("Wants=");
      return hasInvariants &&
        (bindWaitUnit !== undefined ? hasWait : !hasWait);
    }),
    FC_RUNS,
  );
});

// ---------------------------------------------------------------------------
// (d) inventory's ===SECTION=== parser round-trip
// ---------------------------------------------------------------------------

const arbServiceName = fc.stringMatching(/^[a-z][a-z0-9-]{2,15}\.service$/);
const arbListenerRow = fc.record({
  proto: fc.constantFrom("tcp", "udp"),
  ip: fc.tuple(
    fc.integer({ min: 0, max: 255 }),
    fc.integer({ min: 0, max: 255 }),
    fc.integer({ min: 0, max: 255 }),
    fc.integer({ min: 0, max: 255 }),
  ).map(([a, b, c, d]) => `${a}.${b}.${c}.${d}`),
  port: fc.integer({ min: 1, max: 65535 }),
  process: fc.stringMatching(/^[a-z][a-z0-9_]{1,12}$/),
});
const arbProcRow = fc.record({
  name: fc.stringMatching(/^[a-z][a-z0-9_]{1,12}$/),
  count: fc.integer({ min: 1, max: 999 }),
});

function buildInventoryStdout(
  services: string[],
  listeners: { proto: string; ip: string; port: number; process: string }[],
  procs: { name: string; count: number }[],
): string {
  const svcLines = services.join("\n");
  const listenerLines = listeners.map((l) =>
    `${l.proto}   LISTEN 0      4096       ${l.ip}:${l.port}        0.0.0.0:*    users:(("${l.process}",pid=1234,fd=3))`
  ).join("\n");
  const procLines = procs.map((p) => `      ${p.count} ${p.name}`).join("\n");
  return `===SERVICES===\n${svcLines}\n===LISTENERS===\n${listenerLines}\n===PROCS===\n${procLines}\n`;
}

Deno.test("property: inventory's section-parser round-trips arbitrary well-formed services/listeners/processes exactly", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.array(arbServiceName, { minLength: 0, maxLength: 5 }),
      fc.array(arbListenerRow, { minLength: 0, maxLength: 5 }),
      fc.array(arbProcRow, { minLength: 0, maxLength: 5 }),
      async (services, listeners, procs) => {
        const stdout = buildInventoryStdout(services, listeners, procs);
        const { ctx, written } = makeCtx();
        await withCommandStub(
          { success: true, stdout, stderr: "" },
          async () => {
            await run("inventory", {}, ctx);
          },
        );
        const res = written.find((w) => w.spec === "inventory")!;
        const okServices = JSON.stringify(res.payload.runningServices) ===
          JSON.stringify(services);
        const okListeners = JSON.stringify(res.payload.listeners) ===
          JSON.stringify(
            listeners.map((l) => ({
              proto: l.proto,
              local: `${l.ip}:${l.port}`,
              process: l.process,
            })),
          );
        const okProcs = JSON.stringify(res.payload.processes) ===
          JSON.stringify(
            procs.map((p) => ({ name: p.name, count: p.count })),
          );
        return okServices && okListeners && okProcs;
      },
    ),
    FC_RUNS,
  );
});
