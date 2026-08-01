// Shared test harness for @magistr/telegram-import characterization tests.
//
// telegram_import.ts is BYTE-FROZEN (ext-quality-bf-telegram-import) — every
// suite in this backfill drives the SAME shipped `import` method through a
// fake ctx plus a full subprocess/filesystem stub seam, so no test ever
// spawns a real `unzip`/`find`/`obsidian` binary, ever performs a real file
// copy, or ever writes/removes a real directory. The ONLY real filesystem
// call left anywhere in these suites is `Deno.readTextFile` (intentionally
// never stubbed — see `writeRealResultJson` below), reading a small
// harness-owned scratch file that this module writes using Deno primitives
// captured BEFORE any stubbing happens.
//
// Deno 2.8.3 CI skew: no `as typeof <builtin>` casts anywhere in this file —
// every stub assignment goes through `(globalThis as any).Deno.X =` with an
// adjacent `deno-lint-ignore no-explicit-any`, and `restore()` assigns back
// the captured original function reference (no cast needed there).

import { model } from "./telegram_import.ts";

// ---------------------------------------------------------------------------
// Fake ctx — globalArgs, tagged-template-safe logger, capturing writeResource
// ---------------------------------------------------------------------------

export interface WrittenResource {
  spec: string;
  name: string;
  payload: Record<string, unknown>;
}

export interface LogCall {
  level: "info" | "warning" | "error";
  text: string;
  values: unknown[];
}

export interface FakeCtx {
  globalArgs: Record<string, unknown>;
  logger: {
    info: (strings: TemplateStringsArray, ...values: unknown[]) => void;
    warning: (strings: TemplateStringsArray, ...values: unknown[]) => void;
    error: (strings: TemplateStringsArray, ...values: unknown[]) => void;
  };
  writeResource: (
    spec: string,
    name: string,
    payload: Record<string, unknown>,
  ) => Promise<{ spec: string; name: string }>;
}

export const DEFAULT_GLOBAL_ARGS: Record<string, unknown> = {
  zipPath: "/exports/fixture-channel.zip",
  vault: "fixture-vault",
  folder: "Telegram",
  attachmentsFolder: "attachments",
};

/** Build a fake ctx. `logger.info`/`warning`/`error` are called by
 * telegram_import.ts as TAGGED TEMPLATES (`logger.info\`text ${x}\``), so
 * each must accept `(strings, ...values)`, not a plain string. */
export function makeCtx(
  globalArgs: Record<string, unknown> = DEFAULT_GLOBAL_ARGS,
): { ctx: FakeCtx; written: WrittenResource[]; logs: LogCall[] } {
  const written: WrittenResource[] = [];
  const logs: LogCall[] = [];

  function taggedLogger(level: LogCall["level"]) {
    return (strings: TemplateStringsArray, ...values: unknown[]) => {
      let text = strings[0] ?? "";
      for (let i = 0; i < values.length; i++) {
        text += String(values[i]) + (strings[i + 1] ?? "");
      }
      logs.push({ level, text, values });
    };
  }

  const ctx: FakeCtx = {
    globalArgs,
    logger: {
      info: taggedLogger("info"),
      warning: taggedLogger("warning"),
      error: taggedLogger("error"),
    },
    writeResource: (spec, name, payload) => {
      written.push({ spec, name, payload });
      return Promise.resolve({ spec, name });
    },
  };

  return { ctx, written, logs };
}

// ---------------------------------------------------------------------------
// Method runner — mirrors the swamp runtime: arguments are schema-parsed
// (defaults applied) before execute() is invoked.
// ---------------------------------------------------------------------------

type MethodMap = Record<string, {
  arguments: { parse: (a: unknown) => unknown };
  execute: (a: unknown, c: unknown) => Promise<{ dataHandles: unknown[] }>;
}>;

export function runImport(ctx: FakeCtx): Promise<{ dataHandles: unknown[] }> {
  const method = (model.methods as MethodMap)["import"];
  if (!method) throw new Error("model must expose an `import` method");
  return method.execute(method.arguments.parse({}), ctx);
}

// ---------------------------------------------------------------------------
// Real-fs fixture writer — captured BEFORE any stubbing so it is unaffected
// by the Deno.makeTempDir/remove stubs installed below.
// ---------------------------------------------------------------------------

const realMakeTempDir = Deno.makeTempDir.bind(Deno);
const realWriteTextFile = Deno.writeTextFile.bind(Deno);
const realRemove = Deno.remove.bind(Deno);

export interface RealFixture {
  dir: string;
  resultPath: string;
  cleanup: () => Promise<void>;
}

/** Write `payload` (or a raw JSON string via `rawJson`) as result.json into a
 * REAL, harness-owned scratch directory so Deno.readTextFile — intentionally
 * never stubbed — has a real file to read. Nothing else ever touches this
 * directory for real: Deno.copyFile is always stubbed (see installStubs),
 * so a photo/file "read" from beside this file, including a path-traversal
 * payload, is captured as an argv pair and never actually opened. */
export async function writeRealResultJson(
  payload: unknown,
  opts: { rawJson?: string } = {},
): Promise<RealFixture> {
  const dir = await realMakeTempDir({ prefix: "telegram-import-test-" });
  const resultPath = `${dir}/result.json`;
  await realWriteTextFile(resultPath, opts.rawJson ?? JSON.stringify(payload));
  return {
    dir,
    resultPath,
    cleanup: () =>
      realRemove(dir, { recursive: true }).then(() => {}, () => {}),
  };
}

// ---------------------------------------------------------------------------
// Deno.Command / copyFile / mkdir / makeTempDir / remove stub seam
// ---------------------------------------------------------------------------

export interface CommandInvocation {
  cmd: string;
  args: string[];
}

export interface ObsidianCreateCall {
  raw: Record<string, string>;
  path?: string;
  name?: string;
  content?: string;
  overwrite: boolean;
}

export interface CopyInvocation {
  src: string;
  dest: string;
}

export interface StubConfig {
  /** stdout returned by `obsidian vault vault=<v> info=path` */
  vaultPath?: string;
  /** path returned by the `find ... -name result.json` stub — a REAL path
   * from writeRealResultJson, or null to simulate "no result.json found". */
  resultJsonPath?: string | null;
  /** make the unzip subprocess fail (exit 1) */
  unzipFails?: boolean;
  /** make the `find` subprocess itself fail (exit 1, distinct from an empty match) */
  findFails?: boolean;
  /** make the `obsidian create` subprocess fail — boolean or per-call predicate */
  obsidianCreateFails?: boolean | ((call: ObsidianCreateCall) => boolean);
  /** make Deno.copyFile reject for a given invocation */
  copyFileFails?: (inv: CopyInvocation) => boolean;
  /** placeholder path returned by the stubbed Deno.makeTempDir — never
   * touched for real I/O, only ever fed back into other stubbed calls. */
  tempDirPlaceholder?: string;
  /** Leave Deno.mkdir un-stubbed (real). Needed by the vaultRoot (headless)
   * tests (swamp-workspace #57): the confined atomic write's ensureParentDir
   * calls the SAME global Deno.mkdir as the attachments-folder mkdir, so it
   * must be real for a note to actually land on disk under a real
   * `Deno.makeTempDir` vault. Safe to leave real in every other test too --
   * the attachments mkdir target is never asserted against when this is set. */
  realMkdir?: boolean;
  /** Throw when Deno.Command is constructed for "obsidian" (any subcommand).
   * Used by the vaultRoot (headless) tests to hard-prove the CLI is never
   * invoked -- see FakeCommand's constructor. */
  throwOnObsidian?: boolean;
}

export interface InstalledStubs {
  commandInvocations: CommandInvocation[];
  obsidianCreateCalls: ObsidianCreateCall[];
  copyInvocations: CopyInvocation[];
  mkdirCalls: { path: string; recursive: boolean }[];
  removeCalls: string[];
  restore: () => void;
}

const encoder = new TextEncoder();

function parseObsidianArgs(args: string[]): ObsidianCreateCall {
  const raw: Record<string, string> = {};
  let overwrite = false;
  for (const arg of args.slice(1)) {
    if (arg === "overwrite") {
      overwrite = true;
      continue;
    }
    const eq = arg.indexOf("=");
    if (eq === -1) continue;
    raw[arg.slice(0, eq)] = arg.slice(eq + 1);
  }
  return {
    raw,
    path: raw.path,
    name: raw.name,
    content: raw.content,
    overwrite,
  };
}

export function installStubs(config: StubConfig = {}): InstalledStubs {
  const {
    vaultPath = "/vault/fixture-vault",
    resultJsonPath = null,
    unzipFails = false,
    findFails = false,
    obsidianCreateFails = false,
    copyFileFails,
    tempDirPlaceholder = "/fake-tmp/telegram-import-test",
    realMkdir = false,
    throwOnObsidian = false,
  } = config;

  const commandInvocations: CommandInvocation[] = [];
  const obsidianCreateCalls: ObsidianCreateCall[] = [];
  const copyInvocations: CopyInvocation[] = [];
  const mkdirCalls: { path: string; recursive: boolean }[] = [];
  const removeCalls: string[] = [];

  const originalCommand = Deno.Command;
  const originalCopyFile = Deno.copyFile;
  const originalMkdir = Deno.mkdir;
  const originalMakeTempDir = Deno.makeTempDir;
  const originalRemove = Deno.remove;

  class FakeCommand {
    #cmd: string;
    #args: string[];
    constructor(cmd: string, opts: { args?: string[] } = {}) {
      this.#cmd = cmd;
      this.#args = opts.args ?? [];
      // vaultRoot (swamp-workspace #57) must skip the Obsidian CLI entirely --
      // throwing here on construction (before output() is ever called, and
      // before commandInvocations records anything) gives a hard proof that
      // neither the vault-path lookup nor `create` is ever reached when
      // vaultRoot is set, stronger than merely counting invocations after
      // the fact.
      if (throwOnObsidian && cmd === "obsidian") {
        throw new Error(
          "Deno.Command must not be constructed for 'obsidian' when vaultRoot is set -- the CLI must never be invoked",
        );
      }
    }
    output(): Promise<
      { success: boolean; code: number; stdout: Uint8Array; stderr: Uint8Array }
    > {
      commandInvocations.push({ cmd: this.#cmd, args: [...this.#args] });

      if (this.#cmd === "unzip") {
        if (unzipFails) {
          return Promise.resolve({
            success: false,
            code: 1,
            stdout: encoder.encode(""),
            stderr: encoder.encode(
              "unzip:  cannot find or open fixture-channel.zip",
            ),
          });
        }
        return Promise.resolve({
          success: true,
          code: 0,
          stdout: encoder.encode(""),
          stderr: encoder.encode(""),
        });
      }

      if (this.#cmd === "find") {
        if (findFails) {
          return Promise.resolve({
            success: false,
            code: 1,
            stdout: encoder.encode(""),
            stderr: encoder.encode("find: no such file or directory"),
          });
        }
        const out = resultJsonPath ? `${resultJsonPath}\n` : "";
        return Promise.resolve({
          success: true,
          code: 0,
          stdout: encoder.encode(out),
          stderr: encoder.encode(""),
        });
      }

      if (this.#cmd === "obsidian") {
        const sub = this.#args[0];
        if (sub === "vault") {
          return Promise.resolve({
            success: true,
            code: 0,
            stdout: encoder.encode(vaultPath),
            stderr: encoder.encode(""),
          });
        }
        if (sub === "create") {
          const call = parseObsidianArgs(this.#args);
          obsidianCreateCalls.push(call);
          const fails = typeof obsidianCreateFails === "function"
            ? obsidianCreateFails(call)
            : obsidianCreateFails;
          if (fails) {
            return Promise.resolve({
              success: false,
              code: 1,
              stdout: encoder.encode(""),
              stderr: encoder.encode("obsidian create: vault write failed"),
            });
          }
          return Promise.resolve({
            success: true,
            code: 0,
            stdout: encoder.encode("ok"),
            stderr: encoder.encode(""),
          });
        }
      }

      return Promise.resolve({
        success: false,
        code: 127,
        stdout: encoder.encode(""),
        stderr: encoder.encode(
          `installStubs: unrouted Deno.Command invocation: ${this.#cmd} ${
            this.#args.join(" ")
          }`,
        ),
      });
    }
  }

  // deno-lint-ignore no-explicit-any
  (globalThis as any).Deno.Command = FakeCommand;

  // deno-lint-ignore no-explicit-any
  (globalThis as any).Deno.copyFile = (src: string, dest: string) => {
    copyInvocations.push({ src, dest });
    if (copyFileFails?.({ src, dest })) {
      return Promise.reject(
        new Error(`No such file or directory (os error 2): copy '${src}'`),
      );
    }
    return Promise.resolve();
  };

  if (!realMkdir) {
    // deno-lint-ignore no-explicit-any
    (globalThis as any).Deno.mkdir = (
      path: string,
      opts?: { recursive?: boolean },
    ) => {
      mkdirCalls.push({ path, recursive: !!opts?.recursive });
      return Promise.resolve();
    };
  }

  // deno-lint-ignore no-explicit-any
  (globalThis as any).Deno.makeTempDir = (_opts?: { prefix?: string }) =>
    Promise.resolve(tempDirPlaceholder);

  // deno-lint-ignore no-explicit-any
  (globalThis as any).Deno.remove = (
    path: string,
    _opts?: { recursive?: boolean },
  ) => {
    removeCalls.push(path);
    return Promise.resolve();
  };

  return {
    commandInvocations,
    obsidianCreateCalls,
    copyInvocations,
    mkdirCalls,
    removeCalls,
    restore: () => {
      // deno-lint-ignore no-explicit-any
      (globalThis as any).Deno.Command = originalCommand;
      // deno-lint-ignore no-explicit-any
      (globalThis as any).Deno.copyFile = originalCopyFile;
      // deno-lint-ignore no-explicit-any
      (globalThis as any).Deno.mkdir = originalMkdir;
      // deno-lint-ignore no-explicit-any
      (globalThis as any).Deno.makeTempDir = originalMakeTempDir;
      // deno-lint-ignore no-explicit-any
      (globalThis as any).Deno.remove = originalRemove;
    },
  };
}

/** Run `fn` with stubs installed for the duration, always restoring in
 * `finally` — even if `fn` throws (error-path tests rely on this to never
 * leak a monkey-patched Deno.* across test boundaries). */
export async function withStubs(
  config: StubConfig,
  fn: (stubs: InstalledStubs) => Promise<void>,
): Promise<void> {
  const stubs = installStubs(config);
  try {
    await fn(stubs);
  } finally {
    stubs.restore();
  }
}
