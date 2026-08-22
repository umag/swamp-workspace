// Test doubles shared by the swamp-watch suites. No process is ever spawned
// and no socket is ever opened: `scriptedRunner` answers by matching argv, and
// `fakeContext` round-trips written resources through the real Zod schemas.

import type { CommandRunner, RunResult } from "./cli.ts";

/** One recorded invocation. */
export interface RecordedCall {
  cmd: string;
  args: string[];
}

/** A {@link CommandRunner} paired with the calls it recorded. */
export interface ScriptedRunner {
  run: CommandRunner;
  calls: RecordedCall[];
}

/** A {@link RunResult} with sensible defaults. */
export function ok(stdout: string): RunResult {
  return { code: 0, stdout, stderr: "", timedOut: false };
}

/** A failed run: no stdout, message on stderr, like the real swamp CLI. */
export function fail(stderr: string, code = 1): RunResult {
  return { code, stdout: "", stderr, timedOut: false };
}

/**
 * A CommandRunner that answers from `handler` and records every call.
 * A handler returning undefined is a test bug and throws loudly rather than
 * silently producing an empty result.
 */
export function scriptedRunner(
  handler: (args: string[], calls: RecordedCall[]) => RunResult | undefined,
): ScriptedRunner {
  const calls: RecordedCall[] = [];
  const run: CommandRunner = (cmd, args) => {
    calls.push({ cmd, args: [...args] });
    const res = handler(args, calls);
    if (res === undefined) {
      throw new Error(
        `scriptedRunner: no scripted answer for: ${args.join(" ")}`,
      );
    }
    return Promise.resolve(res);
  };
  return { run, calls };
}

/** One resource write captured by {@link fakeContext}. */
export interface WrittenResource {
  spec: string;
  instance: string;
  attrs: unknown;
}

/** An in-memory stand-in for the swamp method context. */
export interface FakeContext {
  globalArgs: Record<string, unknown>;
  writeResource: (
    spec: string,
    instance: string,
    attrs: unknown,
  ) => Promise<unknown>;
  written: WrittenResource[];
}

/** An in-memory method context recording every resource write. */
export function fakeContext(
  globalArgs: Record<string, unknown>,
): FakeContext {
  const written: WrittenResource[] = [];
  return {
    globalArgs,
    written,
    writeResource: (spec, instance, attrs) => {
      written.push({ spec, instance, attrs });
      return Promise.resolve({ spec, instance });
    },
  };
}

/** Parse exposition text into `name{labels} value` triples. */
export function parseExposition(text: string): Array<{
  name: string;
  labels: Record<string, string>;
  value: number;
}> {
  const out: Array<{
    name: string;
    labels: Record<string, string>;
    value: number;
  }> = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const m = line.match(
      /^([a-zA-Z_:][a-zA-Z0-9_:]*)(\{(.*)\})?\s+(-?[\d.eE+]+)$/,
    );
    if (!m) throw new Error(`unparseable exposition line: ${line}`);
    const labels: Record<string, string> = {};
    if (m[3]) {
      for (const pair of m[3].split(/,(?=[a-zA-Z_])/)) {
        const eq = pair.indexOf("=");
        labels[pair.slice(0, eq)] = pair.slice(eq + 2, -1);
      }
    }
    out.push({ name: m[1], labels, value: Number(m[4]) });
  }
  return out;
}

/** All values of `metric` in `text`, keyed by the `workflow` label. */
export function byWorkflow(
  text: string,
  metric: string,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const s of parseExposition(text)) {
    if (s.name === metric) out[s.labels.workflow ?? ""] = s.value;
  }
  return out;
}
