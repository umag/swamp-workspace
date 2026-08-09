/**
 * Property-based tests (fast-check) for @magistr/talm-cluster.
 *
 * talm_cluster.ts is UNMODIFIED — every property here is observed by driving
 * `model.methods.<m>.execute()` against a stubbed `globalThis.Deno.Command`
 * and reading back the captured argv / written resource / on-disk file, per
 * the approved plan (v2). Named invariants (per the plan's adversarial-MED
 * fold-in, naming what coverage/property must NOT leave vacuous):
 *
 *  (a) argv-builder injectivity — distinct (nodeIP, template) pairs produce
 *      distinct `talm template` argv arrays; identical pairs produce
 *      identical argv. Generalizes the contract-fixture suite's one fixed
 *      no-shell-injection example to arbitrary strings.
 *  (b) values.yaml round-trip — configure's raw-interpolated output
 *      re-parses (via a real YAML parser) back to the same field values, for
 *      the well-formed (non-hostile) input subset (the adversarial suite
 *      owns the injection-shaped counter-example).
 *  (c) templateNode post-processing is an idempotent fixed point — for an
 *      arbitrary generated config body (built from a small vocabulary of
 *      disk-line / interface-block / filler shapes), feeding the
 *      post-processed output back through a second pass changes nothing.
 *  (d) nodeIP reaches argv verbatim in its own slots (discovered positionally
 *      against a sentinel reference run, not by naming flag literals) for
 *      ANY string, including ones with shell metacharacters, and never
 *      perturbs the rest of the scaffold — no shell is ever interpreting it
 *      (Deno.Command is invoked with array args).
 *  (e) outputFile -> resource-name derivation is a stable, deterministic
 *      function: same input -> same name, every "/" and "." replaced with
 *      "-", nothing else changed.
 */
import fc from "npm:fast-check@4.8.0";
import { parse as parseYaml } from "jsr:@std/yaml@1.0.10";
import { assertEquals } from "jsr:@std/assert@1";
import { model } from "./talm_cluster.ts";

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

function makeCtx(clusterDir: string) {
  const written: Written[] = [];
  return {
    written,
    ctx: {
      globalArgs: { clusterDir },
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

interface CapturedCall {
  binary: string;
  args: string[];
  cwd?: string;
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
        cwd: opts.cwd as string | undefined,
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

async function withTempClusterDir<T>(
  fn: (dir: string) => Promise<T>,
): Promise<T> {
  const dir = await Deno.makeTempDir();
  try {
    return await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

/** Run templateNode once against `stdout` and return the written file's
 * final content. */
async function templateNodeOnce(
  dir: string,
  ctx: unknown,
  stdout: string,
  outputFile: string,
): Promise<string> {
  await withCommandStub(
    { success: true, stdout, stderr: "" },
    async () => {
      await run("templateNode", { nodeIP: "192.0.2.10", outputFile }, ctx);
    },
  );
  return await Deno.readTextFile(`${dir}/${outputFile}`);
}

// ---------------------------------------------------------------------------
// (a) argv-builder injectivity for templateNode's (nodeIP, template) pair
// ---------------------------------------------------------------------------

const arbArgPair = fc.record({
  nodeIP: fc.stringMatching(/^[a-zA-Z0-9.:-]{1,20}$/),
  template: fc.stringMatching(/^[a-zA-Z0-9._/-]{1,30}$/),
});

async function templateArgvFor(
  pair: { nodeIP: string; template: string },
): Promise<string[]> {
  return await withTempClusterDir(async (dir) => {
    const { ctx } = makeCtx(dir);
    let argv: string[] = [];
    await withCommandStub(
      {
        success: true,
        stdout: "machine:\n  install:\n    disk: /dev/vda\n",
        stderr: "",
      },
      async (calls) => {
        await run("templateNode", {
          nodeIP: pair.nodeIP,
          template: pair.template,
          outputFile: "nodes/p.yaml",
        }, ctx);
        argv = calls[0].args;
      },
    );
    return argv;
  });
}

Deno.test("property: templateNode argv is injective over (nodeIP, template) — same pair -> same argv, different pair -> different argv", async () => {
  await fc.assert(
    fc.asyncProperty(arbArgPair, arbArgPair, async (a, b) => {
      const argvA = await templateArgvFor(a);
      const argvB = await templateArgvFor(b);
      const same = a.nodeIP === b.nodeIP && a.template === b.template;
      return same
        ? JSON.stringify(argvA) === JSON.stringify(argvB)
        : JSON.stringify(argvA) !== JSON.stringify(argvB);
    }),
    FC_RUNS,
  );
});

// ---------------------------------------------------------------------------
// (b) values.yaml round-trip for well-formed (non-hostile) field values
// ---------------------------------------------------------------------------

const arbConfigureInput = fc.record({
  endpoint: fc.stringMatching(/^https:\/\/[a-z0-9.-]{3,20}:[0-9]{2,5}$/),
  floatingIP: fc.stringMatching(
    /^[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}$/,
  ),
  image: fc.stringMatching(
    /^[a-z0-9.\/-]{3,40}:v[0-9]{1,2}\.[0-9]{1,2}\.[0-9]{1,2}$/,
  ),
});

Deno.test("property: configure's values.yaml round-trips through a real YAML parser for well-formed inputs", async () => {
  await fc.assert(
    fc.asyncProperty(arbConfigureInput, async (input) => {
      return await withTempClusterDir(async (dir) => {
        const { ctx } = makeCtx(dir);
        await run("configure", input, ctx);
        const written = await Deno.readTextFile(`${dir}/values.yaml`);
        const parsed = parseYaml(written) as Record<string, unknown>;
        return (
          parsed.endpoint === input.endpoint &&
          parsed.floatingIP === input.floatingIP &&
          parsed.image === input.image &&
          Array.isArray(parsed.podSubnets) &&
          (parsed.podSubnets as string[])[0] === "10.244.0.0/16"
        );
      });
    }),
    FC_RUNS,
  );
});

// ---------------------------------------------------------------------------
// (c) templateNode post-processing is an idempotent fixed point for an
// arbitrary generated config body
// ---------------------------------------------------------------------------

const DISK_LINES = [
  "    disk: /dev/sr0",
  "    disk: /dev/sr1",
  "    disk: /dev/sr9",
  "    disk: /dev/vda",
  "    # no disk line here",
];
const IFACE_BLOCKS = [
  "        - interface: eth0\n          routes:\n            - network: 0.0.0.0/0",
  "        - interface: eth1\n          vip:\n            ip: 192.0.2.20",
  "        - interface: eth2\n          addresses:\n            - 192.0.2.10/24",
  "        # no interface block here",
];
const FILLER_LINES = [
  "    hostname: cp1",
  "    # filler comment line",
  "cluster:",
  "    id: FAKE-ID",
];

// AT MOST ONE disk-line and ONE interface-block per generated document —
// matching a real single-node `talm template` output, which only ever has
// one `machine.install.disk` field. Idempotence genuinely requires this: the
// disk-rewrite regex has no `g` flag (STANDARD.md-pinned gap), so a document
// with TWO "disk: /dev/srN" lines needs a SECOND pass to fully converge
// (pass 1 rewrites only the first; pass 2 then rewrites the newly-first
// remaining one) — a real property of the shipped regex, not a test bug, but
// out of scope for a "one more pass is always a no-op" claim about the
// REALISTIC (at-most-one-disk-line) input shape the contract-fixture suite's
// dedicated multi-disk fixture already pins separately.
const arbConfigBody = fc
  .tuple(
    fc.option(fc.constantFrom(...DISK_LINES), { nil: undefined }),
    fc.option(fc.constantFrom(...IFACE_BLOCKS), { nil: undefined }),
    fc.array(fc.constantFrom(...FILLER_LINES), { minLength: 0, maxLength: 4 }),
  )
  .map(([disk, iface, filler]) => {
    const lines = [...filler];
    if (disk !== undefined) lines.push(disk);
    if (iface !== undefined) lines.push(iface);
    return lines.join("\n") + "\n";
  });

Deno.test("property: templateNode post-processing is idempotent — reprocessing its own output is always a no-op, for arbitrary generated configs", async () => {
  await fc.assert(
    fc.asyncProperty(arbConfigBody, async (body) => {
      return await withTempClusterDir(async (dir) => {
        const { ctx } = makeCtx(dir);
        const pass1 = await templateNodeOnce(
          dir,
          ctx,
          body,
          "nodes/pass1.yaml",
        );
        const pass2 = await templateNodeOnce(
          dir,
          ctx,
          pass1,
          "nodes/pass2.yaml",
        );
        return pass2 === pass1;
      });
    }),
    FC_RUNS,
  );
});

// ---------------------------------------------------------------------------
// (d) nodeIP reaches argv verbatim in its own slots and never perturbs the
// scaffold, for arbitrary strings — no-shell-injection, property form of the
// contract-fixture suite's fixed example
//
// PRIOR ORACLE (removed) counted GLOBAL occurrences of nodeIP in argv:
//   argv.length === 8 && argv[2] === nodeIP && argv[4] === nodeIP &&
//     argv.filter((a) => a === nodeIP).length === 2
// The nightly soak falsified this after 87,042 cases with
// `Counterexample: ["-e"]`. Root cause: templateNode's scaffold argv is
// ["template", "-e", nodeIP, "-n", nodeIP, "-t", template, "-i"], and "-e" is
// simultaneously a scaffold FLAG LITERAL and a value the `fc.string` arbitrary
// can legitimately generate. When nodeIP === "-e", the global occurrence
// count is 3 (the flag itself, plus nodeIP's two real slots), not 2, so the
// filter().length === 2 clause fails even though nodeIP landed correctly,
// verbatim, unsplit, in exactly its two slots — no injection occurred. THE
// MODEL WAS CORRECT; the oracle's use of a global count (rather than
// checking positions) was wrong.
//
// Fix: derive the expected argv SHAPE from the model itself instead of
// hand-copying its flag literals into a second oracle (an oracle must not
// share constants with the code under test — the old oracle didn't share
// literals directly, but it shared the *same failure surface*: "-e" is both
// a scaffold token and a member of the arbitrary's domain). Invoke
// templateNode once with a sentinel nodeIP that cannot coincide with any
// flag or the default template path, and record which argv POSITIONS it
// landed in — those are nodeIP's slots, discovered rather than named. For
// every arbitrary nodeIP the property then asserts POSITIONALLY: nodeIP
// appears verbatim at exactly those slots, and every other position is
// byte-identical to the reference run (i.e. the scaffold truly does not
// depend on nodeIP's value). This is strictly STRONGER than the old
// global-count oracle — it also catches a regression where nodeIP leaked
// into or scrambled a scaffold slot — and it is immune to the "-e"
// coincidence because it never compares nodeIP against the scaffold's own
// literals, only against its own reference-run positions.
// ---------------------------------------------------------------------------

// Spaces + all-caps: can't collide with any of templateNode's flags
// ("-e"/"-n"/"-t"/"-i"), the literal "template", or the default template
// path "templates/controlplane.yaml" — so every slot this sentinel lands in
// is unambiguously a nodeIP slot, not a scaffold literal.
const NODEIP_SENTINEL = " NODEIP ";

async function templateArgvForNodeIP(nodeIP: string): Promise<string[]> {
  return await withTempClusterDir(async (dir) => {
    const { ctx } = makeCtx(dir);
    let argv: string[] = [];
    await withCommandStub(
      {
        success: true,
        stdout: "machine:\n  install:\n    disk: /dev/vda\n",
        stderr: "",
      },
      async (calls) => {
        await run(
          "templateNode",
          { nodeIP, outputFile: "nodes/p.yaml" },
          ctx,
        );
        argv = calls[0].args;
      },
    );
    return argv;
  });
}

Deno.test("property: nodeIP reaches argv verbatim in its own slots and never perturbs the scaffold, for arbitrary strings", async () => {
  const referenceArgv = await templateArgvForNodeIP(NODEIP_SENTINEL);
  const slots = referenceArgv
    .map((value, i) => (value === NODEIP_SENTINEL ? i : -1))
    .filter((i) => i !== -1);
  // Pins the shape (nodeIP occupies exactly two argv slots) WITHOUT naming
  // which flags precede them — if templateNode's argv shape ever changes,
  // this fails loudly here rather than the property below silently checking
  // the wrong positions.
  assertEquals(slots.length, 2);

  await fc.assert(
    fc.asyncProperty(
      fc.string({ minLength: 1, maxLength: 40 }),
      async (nodeIP) => {
        const argv = await templateArgvForNodeIP(nodeIP);
        if (argv.length !== referenceArgv.length) return false;
        for (let i = 0; i < argv.length; i++) {
          if (slots.includes(i)) {
            if (argv[i] !== nodeIP) return false;
          } else if (argv[i] !== referenceArgv[i]) return false;
        }
        return true;
      },
    ),
    FC_RUNS,
  );
});

// Regression: nodeIP === "-e" is the exact counterexample the nightly soak
// found (Counterexample: ["-e"], after 87,042 cases). Pinned as a fixed,
// non-property test so it always runs, independent of fast-check's random
// seed. Under the OLD global-occurrence oracle this case failed (verified
// directly against current model code: argv comes out
// ["template","-e","-e","-n","-e","-t","templates/controlplane.yaml","-i"],
// so argv.filter((a) => a === "-e").length === 3, not 2). Under the new
// positional oracle it passes, because nodeIP still lands verbatim in
// exactly its two slots and nothing else in the scaffold moved.
Deno.test("regression: nodeIP === '-e' (a scaffold flag literal) passes the positional oracle", async () => {
  const referenceArgv = await templateArgvForNodeIP(NODEIP_SENTINEL);
  const slots = referenceArgv
    .map((value, i) => (value === NODEIP_SENTINEL ? i : -1))
    .filter((i) => i !== -1);

  const nodeIP = "-e";
  const argv = await templateArgvForNodeIP(nodeIP);

  // The old oracle: this MUST be false for "-e" — that is the bug.
  const oldOracleWouldHavePassed = argv.length === 8 &&
    argv[2] === nodeIP &&
    argv[4] === nodeIP &&
    argv.filter((a) => a === nodeIP).length === 2;
  assertEquals(
    oldOracleWouldHavePassed,
    false,
    "the old global-occurrence oracle is expected to falsely reject '-e' — " +
      "if this ever becomes true, the counterexample this test pins no " +
      "longer demonstrates the historical defect",
  );

  // The new oracle: this MUST be true for "-e" — nodeIP still travelled
  // verbatim, unmodified, in exactly its own two slots.
  assertEquals(argv.length, referenceArgv.length);
  for (let i = 0; i < argv.length; i++) {
    if (slots.includes(i)) {
      assertEquals(argv[i], nodeIP, `slot ${i} should carry nodeIP verbatim`);
    } else {
      assertEquals(
        argv[i],
        referenceArgv[i],
        `slot ${i} is scaffold and must not depend on nodeIP`,
      );
    }
  }
});

// ---------------------------------------------------------------------------
// (e) outputFile/nodeFile -> resource-name derivation is stable and
// deterministic: same input -> same name; only "/" and "." are replaced
// ---------------------------------------------------------------------------

function sanitize(input: string): string {
  return input.replace(/[/.]/g, "-");
}

// Well-formed relative-file-path shape: alnum-first/alnum-last path segments
// joined by single "/"s. Deliberately excludes path-degenerate values like a
// bare "/" or a trailing slash — those resolve `${dir}/${outputFile}` to a
// DIRECTORY rather than a file (a real, but different, failure mode:
// Deno.writeTextFile then throws IsADirectory) and are out of scope for a
// property about the resource-name sanitizer.
const arbSafeOutputFile = fc.stringMatching(
  /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,8}(\/[a-zA-Z0-9][a-zA-Z0-9._-]{0,8}){0,3}$/,
);

Deno.test("property: templateNode's resource-name derivation is deterministic and touches ONLY '/' and '.'", async () => {
  await fc.assert(
    fc.asyncProperty(
      arbSafeOutputFile,
      async (outputFile) => {
        return await withTempClusterDir(async (dir) => {
          const { ctx, written } = makeCtx(dir);
          await withCommandStub(
            {
              success: true,
              stdout: "machine:\n  install:\n    disk: /dev/vda\n",
              stderr: "",
            },
            async () => {
              await run(
                "templateNode",
                { nodeIP: "192.0.2.10", outputFile },
                ctx,
              );
            },
          );
          const res = written.find((w) => w.spec === "nodeConfig")!;
          return res.name === sanitize(outputFile);
        });
      },
    ),
    FC_RUNS,
  );
});

Deno.test("property: calling templateNode twice with the SAME outputFile derives the SAME resource name both times", async () => {
  await fc.assert(
    fc.asyncProperty(
      arbSafeOutputFile,
      async (outputFile) => {
        return await withTempClusterDir(async (dir) => {
          const { ctx, written } = makeCtx(dir);
          for (let i = 0; i < 2; i++) {
            await withCommandStub(
              {
                success: true,
                stdout: "machine:\n  install:\n    disk: /dev/vda\n",
                stderr: "",
              },
              async () => {
                await run(
                  "templateNode",
                  { nodeIP: "192.0.2.10", outputFile },
                  ctx,
                );
              },
            );
          }
          const names = written.filter((w) => w.spec === "nodeConfig").map((
            w,
          ) => w.name);
          return names.length === 2 && names[0] === names[1];
        });
      },
    ),
    { numRuns: NIGHT(100) },
  );
});
