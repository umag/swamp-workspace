// Bounded, read-only serial console capture for vm.consoleCapture (#262).
//
// `virsh console` has no timeout flag and refuses to run without a TTY, so it
// is wrapped in `script` (which gives it a pty) and bounded twice:
//   - SSH mode: on the hypervisor, `env SHELL=/bin/sh timeout -k <grace> <n>
//     script -qec '<virsh console …>' /dev/null`, plus a Deno-side kill timer
//     on the local ssh process as a backstop.
//   - Local mode: `script` on this host (util-linux `-qec` form on Linux, BSD
//     `script -q /dev/null <argv>` on macOS/BSD) under the Deno-side kill
//     timer only.
//
// Read-only: the child's stdin is a pipe that is held open and never written
// until the process has exited, so no byte (not even an EOF that `script`
// could turn into ^D) reaches the guest console.
//
// Quoting: the inner `virsh console …` command passes through TWO shells in
// SSH mode (the remote login shell, then script's `$SHELL -c`, pinned to
// /bin/sh) and is therefore shell-quoted twice; on Linux local mode once. On
// BSD/macOS the argv is passed to script directly (no inner shell). Domain
// and device names are additionally validated before anything runs.
//
// Like connection.ts, this file is inlined into the vm bundle by the bundler.

import { z } from "npm:zod@4";
import {
  buildSshRaw,
  type Invocation,
  type LibvirtConn,
  shellQuote,
  uriFlag,
} from "./connection.ts";

/** Upper bound for `timeoutSeconds` (5 minutes). */
export const CONSOLE_MAX_TIMEOUT_SECONDS = 300;
/** Seconds the remote `timeout` waits after SIGTERM before SIGKILL. */
const REMOTE_KILL_GRACE_SECONDS = 5;
/** Extra seconds for the ssh connection itself (ConnectTimeout=10 + slack). */
const SSH_SLACK_SECONDS = 15;
/** Captured console text is capped to its LAST this-many bytes. */
export const CONSOLE_MAX_BYTES = 256 * 1024;

// deno-lint-ignore no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f]/;
const DEVICE_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

/** Arguments of vm.consoleCapture. */
export const ConsoleCaptureArgs = z.object({
  name: z.string().describe("VM (domain) name, UUID or id"),
  device: z.string().optional().describe(
    "Console/serial device alias for domains with more than one (virsh console --devname), e.g. serial0 or console1. Default: the domain's first console.",
  ),
  timeoutSeconds: z.number().int().min(1).max(CONSOLE_MAX_TIMEOUT_SECONDS)
    .describe(
      `How long to capture, in seconds (required; 1-${CONSOLE_MAX_TIMEOUT_SECONDS}). The capture always ends by then.`,
    ),
  force: z.boolean().default(true).describe(
    "Pass --force so an existing console session (e.g. an operator's) is disconnected instead of failing the capture (default true).",
  ),
});

/** Parsed consoleCapture options. */
export type ConsoleCaptureOptions = z.infer<typeof ConsoleCaptureArgs>;

/**
 * Validate the user-supplied domain and device names before any process is
 * created. Quoting already makes any name inert to the shell; this rejects
 * names that virsh would parse as an option (leading `-`) or that carry
 * control characters, and restricts device aliases to a plain token.
 */
export function validateConsoleTarget(
  name: string,
  device: string | undefined,
): void {
  if (
    name.length === 0 || name.length > 255 || name.startsWith("-") ||
    CONTROL_RE.test(name)
  ) {
    throw new Error(
      `Invalid domain name ${
        JSON.stringify(name)
      }: must be 1-255 characters, not start with '-', and contain no control characters.`,
    );
  }
  if (device !== undefined && !DEVICE_RE.test(device)) {
    throw new Error(
      `Invalid console device ${
        JSON.stringify(device)
      }: must match [A-Za-z0-9][A-Za-z0-9_.-]* (max 64), e.g. serial0.`,
    );
  }
}

/**
 * Build the command + argv for a bounded console capture. Pure. `os` is the
 * swamp host OS (Deno.build.os), used only in local mode. `knownHostsFile` is
 * the per-call file under hostKeyPolicy "strict" (see withHostKeys).
 */
export function buildConsoleInvocation(
  conn: LibvirtConn,
  opts: Pick<ConsoleCaptureOptions, "name" | "device" | "force"> & {
    timeoutSeconds: number;
  },
  env: { os: string; knownHostsFile?: string },
): Invocation {
  validateConsoleTarget(opts.name, opts.device);
  const virsh = ["virsh", ...uriFlag(conn), "console", opts.name];
  if (opts.device) virsh.push("--devname", opts.device);
  if (opts.force) virsh.push("--force");
  const quotedInner = virsh.map(shellQuote).join(" ");
  if (conn.host) {
    return buildSshRaw(conn, [
      "env",
      "SHELL=/bin/sh",
      "timeout",
      "-k",
      String(REMOTE_KILL_GRACE_SECONDS),
      String(opts.timeoutSeconds),
      "script",
      "-qec",
      quotedInner,
      "/dev/null",
    ], env.knownHostsFile);
  }
  if (env.os === "linux") {
    return {
      command: "env",
      args: ["SHELL=/bin/sh", "script", "-qec", quotedInner, "/dev/null"],
    };
  }
  if (env.os === "windows") {
    throw new Error(
      "consoleCapture in local mode is not supported on Windows (needs `script` for a pty) — use SSH mode.",
    );
  }
  // macOS / BSD script: `script -q <file> <command argv…>` — no inner shell.
  return { command: "script", args: ["-q", "/dev/null", ...virsh] };
}

/**
 * Deno-side hard deadline in ms. Local mode: exactly the timeout (the kill
 * timer IS the bound). SSH mode: the remote `timeout` is the bound; the local
 * timer is a backstop that also covers the remote kill grace and connect time.
 */
export function consoleDeadlineMs(
  conn: LibvirtConn,
  timeoutSeconds: number,
): number {
  if (!conn.host) return timeoutSeconds * 1000;
  return (timeoutSeconds + REMOTE_KILL_GRACE_SECONDS + SSH_SLACK_SECONDS) *
    1000;
}

/**
 * Remove terminal control sequences from captured console output: OSC
 * (titles, hyperlinks), DCS/PM/APC strings, CSI (colors, cursor movement),
 * other ESC sequences (charset selection, keypad mode), then normalize CR...CR LF
 * and lone CR to LF and drop every remaining C0/C1 control character except LF and TAB.
 */
export function stripTerminalControl(text: string): string {
  return text
    // deno-lint-ignore no-control-regex
    .replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, "")
    // deno-lint-ignore no-control-regex
    .replace(/\x1b[P^_X][\s\S]*?\x1b\\/g, "")
    // deno-lint-ignore no-control-regex
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    // deno-lint-ignore no-control-regex
    .replace(/\x1b[ -/]*[0-~]/g, "")
    .replace(/\r+\n/g, "\n")
    .replace(/\r/g, "\n")
    // deno-lint-ignore no-control-regex
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "");
}

/** Result of a bounded run. */
export interface BoundedResult {
  /** Exit code (128+signal when killed). */
  code: number;
  stdout: string;
  stderr: string;
  /** True if the Deno-side deadline fired and the process was killed. */
  timedOut: boolean;
  /** True if stdout exceeded maxBytes and only its tail was kept. */
  truncated: boolean;
}

class TailBuffer {
  #chunks: Uint8Array[] = [];
  #size = 0;
  truncated = false;
  constructor(readonly max: number) {}
  push(chunk: Uint8Array) {
    this.#chunks.push(chunk);
    this.#size += chunk.length;
    while (this.#size > this.max) {
      const over = this.#size - this.max;
      const first = this.#chunks[0];
      this.truncated = true;
      if (first.length <= over) {
        this.#chunks.shift();
        this.#size -= first.length;
      } else {
        this.#chunks[0] = first.subarray(over);
        this.#size -= over;
      }
    }
  }
  text(): string {
    const all = new Uint8Array(this.#size);
    let off = 0;
    for (const c of this.#chunks) {
      all.set(c, off);
      off += c.length;
    }
    return new TextDecoder().decode(all);
  }
}

/**
 * Spawn `command args` and bound it in time and output size. stdin is a pipe
 * held open and never written while the process runs (no input, no EOF). At
 * `deadlineMs` the process gets SIGTERM, `killGraceMs` later SIGKILL. Output
 * draining after exit is bounded by `killGraceMs` too, so a grandchild that
 * keeps a pipe open cannot block the caller. Keeps the last `maxBytes` of
 * stdout. Never throws on a non-zero exit.
 */
export async function runBounded(
  command: string,
  args: string[],
  opts: { deadlineMs: number; killGraceMs: number; maxBytes: number },
): Promise<BoundedResult> {
  // @ts-ignore Deno global is available at bundle/runtime.
  const child = new Deno.Command(command, {
    args,
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  const stdinWriter = child.stdin.getWriter();
  const out = new TailBuffer(opts.maxBytes);
  const err = new TailBuffer(64 * 1024);
  const outReader = child.stdout.getReader();
  const errReader = child.stderr.getReader();
  const pump = async (
    reader: ReadableStreamDefaultReader<Uint8Array>,
    buf: TailBuffer,
  ) => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        buf.push(value);
      }
    } catch {
      // stream cancelled or errored — keep what was read
    }
  };
  const pumps = Promise.all([pump(outReader, out), pump(errReader, err)]);

  let timedOut = false;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const kill = (sig: "SIGTERM" | "SIGKILL") => {
    try {
      child.kill(sig);
    } catch {
      // already exited
    }
  };
  const termTimer = setTimeout(() => {
    timedOut = true;
    kill("SIGTERM");
    killTimer = setTimeout(() => kill("SIGKILL"), opts.killGraceMs);
  }, opts.deadlineMs);

  let status: { code: number };
  try {
    status = await child.status;
  } finally {
    clearTimeout(termTimer);
    if (killTimer !== undefined) clearTimeout(killTimer);
  }

  let drainTimer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    pumps,
    new Promise((resolve) => {
      drainTimer = setTimeout(resolve, opts.killGraceMs);
    }),
  ]);
  clearTimeout(drainTimer);
  await Promise.allSettled([outReader.cancel(), errReader.cancel()]);
  await pumps;
  try {
    await stdinWriter.close();
  } catch {
    // the process is gone; nothing to close
  }
  return {
    code: status.code,
    stdout: out.text(),
    stderr: err.text(),
    timedOut,
    truncated: out.truncated,
  };
}
