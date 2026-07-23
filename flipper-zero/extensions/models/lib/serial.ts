/**
 * Serial I/O for the Flipper Zero USB CDC-ACM CLI, done entirely through
 * subprocesses (`ls`, `bash`, `stty`, `cat`).
 *
 * Why subprocesses instead of `Deno.open`? On macOS, `/dev` device nodes
 * require Deno's `--allow-all` (a scoped `--allow-read` is rejected with
 * `NotCapable`), and swamp does not run model code with `--allow-all`. A child
 * process, however, runs with the user's full OS privileges — swamp only needs
 * to grant `--allow-run` to spawn it — so the child can open the device freely.
 * This is the same pattern every other swamp model uses to reach privileged
 * resources (shelling out to `aws`, `ssh`, etc.).
 *
 * Each exchange opens the port read/write, puts the line in raw/no-echo mode
 * with an idle read timeout (`min 0 time N`), sends one command, and lets `cat`
 * drain the reply until the line goes quiet (a 0-byte VTIME read is EOF to
 * `cat`). A hard timeout kills the child as a backstop for streaming commands.
 *
 * Text framing (echo/prompt stripping) lives in ./protocol.ts.
 *
 * @module
 */

/** Options controlling a single command exchange. */
export interface ExchangeOptions {
  /** Baud rate passed to stty (cosmetic for USB-CDC, but must be numeric). */
  baud: string;
  /** Hard cap on the whole exchange, in milliseconds (kills the child). */
  timeoutMs: number;
  /**
   * Silence gap that ends a read, in milliseconds (maps to stty VTIME).
   * Defaults to 1000ms, or 400ms for fire-and-forget commands.
   */
  idleMs?: number;
  /**
   * When false, expect the port to drop (e.g. `power reboot`): use a short
   * idle/timeout and don't treat an early exit as an error. Defaults to true.
   */
  waitForPrompt?: boolean;
  /** Hard cap on captured bytes (defaults to 1 MiB). */
  maxBytes?: number;
}

/** Outcome of a command exchange. */
export interface ExchangeResult {
  /** Raw bytes captured (still contains echo, ANSI, banner, and prompts). */
  raw: string;
  /** True when the hard timeout elapsed and the child was killed. */
  timedOut: boolean;
  /** True when the maxBytes cap was hit and capture was truncated. */
  truncated: boolean;
}

const DEFAULT_MAX_BYTES = 1024 * 1024;
const STTY_FILE_FLAG = Deno.build.os === "darwin" ? "-f" : "-F";
const CHILD_PATH = "/bin:/usr/bin:/usr/local/bin";

function childEnv(extra: Record<string, string>): Record<string, string> {
  return { PATH: CHILD_PATH, ...extra };
}

/** List the bare entries of `/dev` via `ls` (empty on failure). */
export async function listDevNames(): Promise<string[]> {
  try {
    const { stdout } = await new Deno.Command("ls", {
      args: ["/dev"],
      clearEnv: true,
      env: childEnv({}),
      stdout: "piped",
      stderr: "null",
    }).output();
    return new TextDecoder().decode(stdout)
      .split("\n")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  } catch {
    return [];
  }
}

function assertPortPath(port: string): void {
  if (!port || !port.startsWith("/dev/") || /[\s;|&$`'"\\]/.test(port)) {
    throw new Error(
      `Invalid serial port path ${JSON.stringify(port)} — must be a plain ` +
        `/dev/... path.`,
    );
  }
}

function assertBaud(baud: string): void {
  if (!/^\d+$/.test(baud)) {
    throw new Error(`Invalid baud rate ${JSON.stringify(baud)} — digits only.`);
  }
}

function buildScript(baud: string, idleDecis: number): string {
  // The device path and command are passed via env (FZ_PORT / FZ_CMD) so they
  // are never interpolated into the shell. Only the validated numeric baud and
  // idle timeout are interpolated.
  return [
    'exec 3<>"$FZ_PORT"',
    `stty ${STTY_FILE_FLAG} "$FZ_PORT" ${baud} raw -echo min 0 time ${idleDecis}`,
    'printf "%s\\r" "$FZ_CMD" >&3',
    // exec so the process we may SIGKILL *is* cat (no orphaned reader holding
    // the port / stdout pipe open, which would hang child.output()).
    "exec cat <&3",
  ].join("\n");
}

/**
 * Open the port, send a single command, and capture the reply. `command` must
 * be a single line (the caller validates); no newline is appended beyond the
 * carriage return the Flipper CLI expects.
 */
export async function exchange(
  port: string,
  command: string,
  opts: ExchangeOptions,
): Promise<ExchangeResult> {
  assertPortPath(port);
  assertBaud(opts.baud);

  const waitForPrompt = opts.waitForPrompt !== false;
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const idleMs = opts.idleMs ?? (waitForPrompt ? 1000 : 400);
  const idleDecis = Math.min(255, Math.max(1, Math.round(idleMs / 100)));
  const hardTimeoutMs = waitForPrompt
    ? opts.timeoutMs
    : Math.min(3000, opts.timeoutMs);

  const child = new Deno.Command("bash", {
    args: ["-c", buildScript(opts.baud, idleDecis)],
    clearEnv: true,
    env: childEnv({ FZ_PORT: port, FZ_CMD: command }),
    stdout: "piped",
    stderr: "piped",
  }).spawn();

  let killed = false;
  const timer = setTimeout(() => {
    killed = true;
    try {
      child.kill("SIGKILL");
    } catch {
      // already exited
    }
  }, hardTimeoutMs);

  const { code, stdout, stderr } = await child.output();
  clearTimeout(timer);

  const raw = new TextDecoder().decode(stdout);
  const err = new TextDecoder().decode(stderr).trim();

  if (raw.length === 0 && !killed) {
    if (/resource busy|device busy|\bbusy\b/i.test(err)) {
      throw new Error(
        `Serial port ${port} is busy — quit qFlipper or any serial terminal ` +
          `holding it, then retry. (${err})`,
      );
    }
    if (code !== 0 || err.length > 0) {
      throw new Error(
        `Failed to communicate with ${port}: ${err || `bash exit ${code}`}`,
      );
    }
    // Exit 0 with no output for a real command usually means nothing replied.
    if (waitForPrompt) {
      throw new Error(
        `No response from ${port}. Is the Flipper unlocked and on the CLI? ` +
          `Try increasing timeoutMs.`,
      );
    }
  }

  const truncated = raw.length > maxBytes;
  return {
    raw: truncated ? raw.slice(0, maxBytes) : raw,
    timedOut: killed,
    truncated,
  };
}

/**
 * Enter the Flipper's binary RPC mode (`start_rpc_session`), send a
 * length-delimited protobuf request, and capture the raw binary response for
 * `timeoutMs`. Returns the captured bytes verbatim (the caller locates the
 * protobuf message it wants). Used for screen-frame capture.
 */
export async function captureRpc(
  port: string,
  requestBytes: Uint8Array,
  opts: { baud: string; timeoutMs: number; settleMs?: number },
): Promise<Uint8Array> {
  assertPortPath(port);
  assertBaud(opts.baud);
  // Emit the request bytes with printf \xHH escapes (binary-safe, no NUL in the
  // shell string). requestBytes are model-controlled, not user input.
  const hex = Array.from(requestBytes)
    .map((b) => `\\x${b.toString(16).padStart(2, "0")}`)
    .join("");
  const settle = ((opts.settleMs ?? 500) / 1000).toFixed(2);
  const script = [
    'exec 3<>"$FZ_PORT"',
    `stty ${STTY_FILE_FLAG} "$FZ_PORT" ${opts.baud} raw -echo min 0 time 20`,
    "printf 'start_rpc_session\\r' >&3",
    `sleep ${settle}`,
    `printf '${hex}' >&3`,
    // exec so the SIGKILL target is cat itself (the screen stream never idles,
    // so the hard timeout always kills it — must not orphan the reader).
    "exec cat <&3",
  ].join("\n");

  const child = new Deno.Command("bash", {
    args: ["-c", script],
    clearEnv: true,
    env: childEnv({ FZ_PORT: port }),
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  const timer = setTimeout(() => {
    try {
      child.kill("SIGKILL");
    } catch {
      // already exited
    }
  }, opts.timeoutMs);
  const { stdout } = await child.output();
  clearTimeout(timer);
  return stdout;
}

function hexEscape(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => `\\x${b.toString(16).padStart(2, "0")}`)
    .join("");
}

/**
 * Enter RPC mode, send `open`, hold the session open for `holdMs` (a virtual
 * display only persists while the session lives), then send `close` and exit.
 * Nothing is read back.
 */
export async function sendRpcHold(
  port: string,
  open: Uint8Array,
  close: Uint8Array,
  opts: { baud: string; holdMs: number; settleMs?: number },
): Promise<void> {
  assertPortPath(port);
  assertBaud(opts.baud);
  const settle = ((opts.settleMs ?? 500) / 1000).toFixed(2);
  const hold = Math.max(0.2, opts.holdMs / 1000).toFixed(2);
  const script = [
    'exec 3<>"$FZ_PORT"',
    `stty ${STTY_FILE_FLAG} "$FZ_PORT" ${opts.baud} raw -echo min 0 time 20`,
    "printf 'start_rpc_session\\r' >&3",
    `sleep ${settle}`,
    `printf '${hexEscape(open)}' >&3`,
    `sleep ${hold}`,
    `printf '${hexEscape(close)}' >&3`,
    "sleep 0.2",
  ].join("\n");

  const { code, stderr } = await new Deno.Command("bash", {
    args: ["-c", script],
    clearEnv: true,
    env: childEnv({ FZ_PORT: port }),
    stdout: "null",
    stderr: "piped",
  }).output();
  if (code !== 0) {
    const msg = new TextDecoder().decode(stderr).trim();
    if (/resource busy|device busy|\bbusy\b/i.test(msg)) {
      throw new Error(
        `Serial port ${port} is busy — quit qFlipper or any serial terminal ` +
          `holding it, then retry. (${msg})`,
      );
    }
    throw new Error(
      `Failed to drive ${port} over RPC: ${msg || `exit ${code}`}`,
    );
  }
}
