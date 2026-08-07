/**
 * Shared doubles for the herdr suites: a scripted {@link CommandRunner} that
 * records every argv instead of spawning herdr, a method-context double that
 * validates each write against the model's REAL Zod schema, and a loader for
 * the captured wire-format fixtures.
 *
 * No suite in this extension ever spawns a process or opens a socket.
 */

import { z } from "npm:zod@4";
import type { CommandRunner, RunOptions, RunResult } from "./cli.ts";
import type { EnvGetter, HerdrConfig, SshTarget } from "./cli.ts";
import type { HerdrContext } from "../herdr.ts";

/** A local-transport {@link HerdrConfig} for transport-level tests. */
export function testConfig(
  overrides: Partial<HerdrConfig> = {},
): HerdrConfig {
  return {
    binary: "herdr",
    session: "",
    socketPath: "",
    timeoutMs: 30_000,
    ssh: null,
    ...overrides,
  };
}

/** The same config pointed at a remote host over ssh. */
export function sshConfig(
  ssh: Partial<SshTarget> = {},
  overrides: Partial<HerdrConfig> = {},
): HerdrConfig {
  return testConfig({
    ...overrides,
    ssh: {
      host: "build.example",
      user: "",
      port: 0,
      identityFile: "",
      binary: "",
      extraArgs: [],
      ...ssh,
    },
  });
}

/** One recorded subprocess invocation. */
export interface RecordedCall {
  cmd: string;
  args: string[];
  opts?: RunOptions;
}

/** What a scripted handler may answer with. */
export type ScriptedReply = string | Partial<RunResult> | void;

/**
 * A {@link CommandRunner} that never spawns anything.
 *
 * The handler sees the argv and answers with a string (stdout, exit 0), a
 * partial {@link RunResult}, or nothing (silent success — the shape herdr's
 * `send-text`/`send-keys`/`run` actually return). Throwing from the handler
 * simulates a spawn failure.
 */
export function scriptedRunner(
  handler: (args: string[], call: RecordedCall) => ScriptedReply,
): { run: CommandRunner; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const run: CommandRunner = (cmd, args, opts) => {
    const call: RecordedCall = { cmd, args, opts };
    calls.push(call);
    const reply = handler(args, call);
    if (typeof reply === "string") {
      return Promise.resolve({ code: 0, stdout: reply, stderr: "" });
    }
    return Promise.resolve({
      code: 0,
      stdout: "",
      stderr: "",
      ...(reply ?? {}),
    });
  };
  return { run, calls };
}

/**
 * Answer from a table keyed by an argv prefix, e.g. `"pane get"`.
 *
 * The longest matching prefix wins, so `"agent list"` and `"agent start"` can
 * coexist. An unmatched argv throws, which turns "the model called something
 * the test did not expect" into a red test rather than a silent empty reply.
 */
export function tableRunner(
  table: Record<string, ScriptedReply | (() => ScriptedReply)>,
): { run: CommandRunner; calls: RecordedCall[] } {
  return scriptedRunner((args) => {
    const joined = args.join(" ");
    const keys = Object.keys(table)
      .filter((k) => joined === k || joined.startsWith(`${k} `))
      .sort((a, b) => b.length - a.length);
    if (keys.length === 0) {
      throw new Error(`no scripted reply for: herdr ${joined}`);
    }
    const entry = table[keys[0]];
    return typeof entry === "function" ? entry() : entry;
  });
}

/** Wrap a value as herdr's success envelope, the way its CLI prints it. */
export function envelope(result: Record<string, unknown>): string {
  return `${JSON.stringify({ id: "cli:test", result })}\n`;
}

/** Wrap a code/message as herdr's error envelope (stdout, non-zero exit). */
export function errorEnvelope(
  code: string,
  message: string,
): Partial<RunResult> {
  return {
    code: 1,
    stdout: `${JSON.stringify({ error: { code, message }, id: "cli:test" })}\n`,
    stderr: "",
  };
}

/** One recorded `writeResource` call. */
export interface Written {
  spec: string;
  instance: string;
  data: Record<string, unknown>;
}

/** Minimal shape of the model export the doubles need. */
interface ModelLike {
  resources: Record<string, { schema: z.ZodTypeAny }>;
}

/**
 * A method-context double.
 *
 * Every write is validated against the model's declared resource schema, so
 * a method that drifts from its own contract fails in the suite that exercises
 * it rather than at `swamp model method run` time.
 */
export function fakeContext(
  model: ModelLike,
  globalArgs: Record<string, unknown> = {},
): { ctx: HerdrContext; written: Written[] } {
  const written: Written[] = [];
  const ctx: HerdrContext = {
    globalArgs,
    writeResource(specName, instanceName, data) {
      const spec = model.resources[specName];
      if (!spec) {
        throw new Error(`unknown resource spec ${specName}`);
      }
      const parsed = spec.schema.safeParse(data);
      if (!parsed.success) {
        throw new Error(
          `resource ${specName}/${instanceName} violates its schema: ${
            JSON.stringify(parsed.error.issues)
          }`,
        );
      }
      written.push({
        spec: specName,
        instance: instanceName,
        data: data as Record<string, unknown>,
      });
      return Promise.resolve({
        name: instanceName,
        specName,
        kind: "resource",
        version: written.length,
      });
    },
  };
  return { ctx, written };
}

/** An {@link EnvGetter} backed by a plain object — never touches `Deno.env`. */
export function fakeEnv(vars: Record<string, string> = {}): EnvGetter {
  return (key) => vars[key];
}

/** The single write of a given spec, or a failure if there is not exactly one. */
export function onlyWrite(written: Written[], spec: string): Written {
  const matches = written.filter((w) => w.spec === spec);
  if (matches.length !== 1) {
    throw new Error(
      `expected exactly 1 ${spec} write, saw ${matches.length}`,
    );
  }
  return matches[0];
}

/** Every argv this run issued, joined for readable assertions. */
export function argvLines(calls: RecordedCall[]): string[] {
  return calls.map((c) => c.args.join(" "));
}

// --- Fixtures ----------------------------------------------------------------

const FIXTURE_DIR = new URL("../../../fixtures/", import.meta.url);

let cache: Record<string, unknown> | null = null;

/** Load the captured herdr 0.8.0 wire-format fixtures (cached). */
export async function fixtures(): Promise<Record<string, unknown>> {
  if (!cache) {
    const text = await Deno.readTextFile(
      new URL("herdr_0.8.0.json", FIXTURE_DIR),
    );
    cache = JSON.parse(text) as Record<string, unknown>;
  }
  return cache;
}

/** One fixture envelope, serialised the way the CLI prints it. */
export async function fixtureStdout(name: string): Promise<string> {
  const all = await fixtures();
  const value = all[name];
  if (value === undefined) throw new Error(`no fixture named ${name}`);
  return `${JSON.stringify(value)}\n`;
}

/** One fixture's `result` object, as the transport would hand it to a method. */
export async function fixtureResult(
  name: string,
): Promise<Record<string, unknown>> {
  const all = await fixtures();
  const value = all[name] as Record<string, unknown> | undefined;
  if (!value) throw new Error(`no fixture named ${name}`);
  return (value.result ?? value) as Record<string, unknown>;
}

/** The captured `herdr status` text block. */
export function statusFixture(): Promise<string> {
  return Deno.readTextFile(new URL("status.txt", FIXTURE_DIR));
}
