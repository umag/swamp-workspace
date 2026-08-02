// SSH helpers shared across extension models.
//
// Secure-by-default host-key verification (issue swamp-go-brr-latent-bugs B3):
// `StrictHostKeyChecking=accept-new` (TOFU — trusts an unseen host key on first
// contact, but REFUSES a host whose stored key later CHANGES) is the default, and
// ssh's own known_hosts file is used (never forced to /dev/null). The historical
// insecure behavior (`no` + `UserKnownHostsFile=/dev/null`) is reachable only via an
// explicit, documented opt-out (`strictHostKeyChecking: "no"`).
//
// Client-side timeout (issue swamp-go-brr-latent-bugs B1): ssh's own `ConnectTimeout`
// bounds only the TCP/handshake phase — a hung REMOTE command (e.g. a wedged `docker
// run`) can otherwise hang the whole ssh session indefinitely. `timeoutMs`, when set,
// wraps the whole invocation (handshake + remote command) in an AbortController; on
// expiry the child is killed and a synthetic `{code:124,...}` is returned (fail-closed
// — 124 mirrors coreutils' `timeout` convention). The timer is always cleared in a
// `finally` so a normal (non-timing-out) call never leaks a pending timer.

/** ssh's `StrictHostKeyChecking` mode. `accept-new` (default) is TOFU; `yes` requires
 * the host key to already be known; `no` fully disables verification — a documented,
 * explicit insecure opt-out only (issue swamp-go-brr-latent-bugs B3). */
export type StrictHostKeyChecking = "accept-new" | "yes" | "no";

/** Per-call ssh transport options. All fields are optional; secure defaults apply. */
export interface SshOptions {
  /** @default "accept-new" */
  strictHostKeyChecking?: StrictHostKeyChecking;
  /** Override ssh's `UserKnownHostsFile`. When `strictHostKeyChecking` is `"no"` and
   * this is unset, defaults to `/dev/null` (the historical insecure behavior) so the
   * opt-out stays fully self-contained. Otherwise ssh's own default known_hosts file
   * is used unless this is explicitly set. */
  knownHostsFile?: string;
  /** Client-side wall-clock budget (ms) for the WHOLE ssh invocation — handshake plus
   * the remote command's runtime. `undefined`/`0`/negative disables the timeout. */
  timeoutMs?: number;
}

export function isValidSshHost(host: unknown): boolean {
  if (!host) return false;
  if (typeof host !== "string") return false;
  if (host === "null" || host === "undefined") return false;
  return true;
}

/** Build the `-o` host-key-verification argv pair(s) for the given options. */
function hostKeyArgs(opts: SshOptions | undefined): string[] {
  const strict = opts?.strictHostKeyChecking ?? "accept-new";
  const args = ["-o", `StrictHostKeyChecking=${strict}`];
  const knownHosts = opts?.knownHostsFile ??
    (strict === "no" ? "/dev/null" : undefined);
  if (knownHosts !== undefined) {
    args.push("-o", `UserKnownHostsFile=${knownHosts}`);
  }
  return args;
}

type CommandResult = { code: number; stdout: string; stderr: string };

/**
 * Run `ssh user@ip command` with secure-by-default host-key verification and an
 * optional client-side timeout wrapping the whole invocation. On timeout the child
 * is killed via AbortController and a synthetic `{code:124,...}` is returned
 * (fail-closed) regardless of whether the underlying `Deno.Command` promise itself
 * rejects or resolves once the process is killed. The timer is always cleared in
 * `finally`.
 */
async function runSsh(
  ip: string,
  user: string,
  command: string,
  opts: SshOptions | undefined,
): Promise<CommandResult> {
  const controller = new AbortController();
  const timeoutMs = opts?.timeoutMs;
  let timer: ReturnType<typeof setTimeout> | undefined;
  if (timeoutMs && timeoutMs > 0) {
    timer = setTimeout(() => controller.abort(), timeoutMs);
  }
  try {
    // @ts-ignore - Deno API
    const proc = new Deno.Command("ssh", {
      args: [
        ...hostKeyArgs(opts),
        "-o",
        "ConnectTimeout=10",
        `${user}@${ip}`,
        command,
      ],
      signal: controller.signal,
    });
    try {
      const result = await proc.output();
      if (controller.signal.aborted) {
        return {
          code: 124,
          stdout: "",
          stderr: `ssh timed out after ${timeoutMs}ms`,
        };
      }
      return {
        code: result.code,
        stdout: new TextDecoder().decode(result.stdout),
        stderr: new TextDecoder().decode(result.stderr),
      };
    } catch (e) {
      if (controller.signal.aborted) {
        return {
          code: 124,
          stdout: "",
          stderr: `ssh timed out after ${timeoutMs}ms`,
        };
      }
      throw e;
    }
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Run over ssh; throws on a non-zero exit (see `sshExecRaw` for the raw variant). */
export async function sshExec(
  ip: string,
  user: string,
  command: string,
  opts?: SshOptions,
): Promise<CommandResult> {
  const result = await runSsh(ip, user, command, opts);
  if (result.code !== 0) {
    throw new Error(
      `SSH command failed (exit ${result.code}): ${result.stderr.slice(-500)}`,
    );
  }
  return result;
}

/** Run over ssh; never throws on a non-zero exit — the caller inspects `code`. */
export async function sshExecRaw(
  ip: string,
  user: string,
  command: string,
  opts?: SshOptions,
): Promise<CommandResult> {
  return await runSsh(ip, user, command, opts);
}

export async function waitForSsh(
  ip: string,
  user: string,
  timeoutSeconds = 60,
  pollInterval = 3,
  opts?: SshOptions,
): Promise<boolean> {
  const deadline = Date.now() + (timeoutSeconds * 1000);

  while (Date.now() < deadline) {
    const result = await sshExecRaw(ip, user, "echo ready", opts);
    if (result.code === 0 && result.stdout.trim() === "ready") {
      return true;
    }
    await new Promise((r) => setTimeout(r, pollInterval * 1000));
  }

  return false;
}
