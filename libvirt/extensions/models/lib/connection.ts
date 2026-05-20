// Connection helpers shared across the @magistr/libvirt models.
//
// Two transports, selected per call from the model's globalArgs:
//   - SSH mode       (globalArgs.host set): runs `virsh` on the remote host
//     over ssh — no local libvirt client needed. This is the original
//     behavior; SSH options are preserved exactly (host-key hardening is
//     tracked separately as issue libvirt-ssh-hardening).
//   - Local/URI mode (no host): runs `virsh` on the swamp host, selecting the
//     libvirt connection via `-c <uri>` (default qemu:///system). Supports
//     qemu+ssh://, qemu+tls://, qemu:///session, etc.
//
// `buildInvocation` is a pure function (no I/O): it returns the exact command
// + argv that would run, so transport selection and shell-quoting are unit
// testable. On the SSH path EVERY token (subcommand, names, paths, flags AND
// flag values, and the uri) is shell-quoted — there is no raw interpolation —
// which closes the command-injection class present in the SSH-only original
// (which escaped only the resource name). Local mode passes argv straight to
// Deno.Command, so no shell is involved at all.
//
// This file is intentionally NOT listed in manifest `models:` (no
// `export const model`); the bundler inlines it into each model bundle.

/** Connection target value object, taken from a model's `globalArgs`. */
export interface LibvirtConn {
  /** SSH host/IP. If set, virsh runs on this host over ssh. */
  host?: string;
  /** SSH username (SSH mode only; default root). */
  user?: string;
  /** Libvirt connection URI. Local mode defaults to qemu:///system. */
  uri?: string;
}

/** Result of running a command (virsh or ssh). */
export interface VirshResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** A resolved command invocation: the binary and its argv. */
export interface Invocation {
  command: string;
  args: string[];
}

// SSH options. StrictHostKeyChecking=accept-new pins the host key on first use
// (TOFU) and refuses a later changed key — far safer than blindly accepting
// every connection. BatchMode=yes fails fast instead of hanging on an auth
// prompt in the no-TTY Deno.Command context. Keys persist to the default
// known_hosts; rotating a host key requires clearing its stale entry, and a
// writable known_hosts is required (see README). First-connect is still
// trust-on-first-use — pre-seed known_hosts (ssh-keyscan) out of band to close
// that gap.
const SSH_OPTS = [
  "-o",
  "StrictHostKeyChecking=accept-new",
  "-o",
  "BatchMode=yes",
  "-o",
  "ConnectTimeout=10",
];

const DEFAULT_URI = "qemu:///system";

/**
 * POSIX single-quote a string so it survives one level of remote shell
 * parsing intact (used only on the SSH path). Closing-then-escaping each
 * embedded quote is the canonical safe form: `'` becomes `'\''`. An empty
 * string yields `''`.
 */
export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/**
 * Human-readable label for the connection target, used to populate the
 * backward-compatible `host` output field. In SSH mode this is the host (so
 * existing data consumers are unaffected); in local mode it is the uri.
 */
export function connLabel(conn: LibvirtConn): string {
  return conn.host || conn.uri || DEFAULT_URI;
}

/**
 * The `-c <uri>` prefix for a virsh invocation. Local mode always pins the uri
 * (defaulting to qemu:///system); SSH mode only passes `-c` when the caller
 * explicitly set a uri, otherwise the remote virsh uses its own default.
 */
export function uriFlag(conn: LibvirtConn): string[] {
  if (!conn.host) return ["-c", conn.uri ?? DEFAULT_URI];
  return conn.uri ? ["-c", conn.uri] : [];
}

/**
 * Build the ssh invocation for a NON-virsh remote command (e.g. `ip route`).
 * Pure; throws in local mode because there is no remote shell to target. Every
 * token is shell-quoted so an injected token stays a single argument.
 */
export function buildSshRaw(conn: LibvirtConn, argv: string[]): Invocation {
  if (!conn.host) {
    throw new Error(
      "This operation requires SSH host mode — set the `host` global argument.",
    );
  }
  const remote = argv.map(shellQuote).join(" ");
  const target = `${conn.user || "root"}@${conn.host}`;
  return { command: "ssh", args: [...SSH_OPTS, target, remote] };
}

/**
 * Build the command + argv for a virsh subcommand without running it. Pure.
 * Local mode -> {command:"virsh", args:[...uriFlag, ...argv]} (argv passed
 * directly to Deno.Command, no shell). SSH mode -> {command:"ssh", args:[
 * ...sshOpts, user@host, "<every token shell-quoted and space-joined>"]}.
 */
export function buildInvocation(conn: LibvirtConn, argv: string[]): Invocation {
  const full = [...uriFlag(conn), ...argv];
  if (!conn.host) {
    return { command: "virsh", args: full };
  }
  const remote = ["virsh", ...full].map(shellQuote).join(" ");
  const target = `${conn.user || "root"}@${conn.host}`;
  return { command: "ssh", args: [...SSH_OPTS, target, remote] };
}

/**
 * Idempotency error-substring sets the models match in a `virshTry` result's
 * stderr to treat an operation as a no-op success rather than a failure. Each
 * set is anchored to its specific resource so that an UNRELATED "not found"
 * error is NOT silently swallowed — when in doubt the model throws. Shared by
 * the models and the idempotency tests so the two cannot drift.
 */
export const IDEMPOTENT_ERRORS = {
  /** `virsh start` on an already-running domain. */
  vmAlreadyRunning: ["already active", "is already running"],
  /** `virsh shutdown`/`destroy` on a stopped domain. */
  vmNotRunning: ["domain is not running"],
  /** `virsh undefine`/`domstate` on a domain that does not exist. */
  domainNotFound: ["failed to get domain", "Domain not found"],
  /** `virsh detach-disk` for a disk that is not attached. */
  diskNotFound: ["No disk found", "disk not found", "no target device"],
  /** `virsh pool-start` on an already-active pool. */
  poolAlreadyActive: ["already active"],
  /** `virsh pool-define-as`/`vol-create-as` for an object that exists. */
  alreadyExists: ["already exists"],
} as const;

/**
 * Case-sensitive substring match of `haystack` against any of `needles`. Used
 * by the models to detect idempotent virsh errors (see `IDEMPOTENT_ERRORS`) in
 * a `virshTry` result's stderr without throwing. Exported so the exact
 * substrings the models rely on are unit-tested against captured virsh output.
 */
export function includesAny(
  haystack: string,
  needles: readonly string[],
): boolean {
  return needles.some((n) => haystack.includes(n));
}

/**
 * True if a failed `virshTry` result indicates an idempotent no-op — matching
 * `needles` against BOTH stderr and stdout (virsh writes errors to stderr, but
 * the original SSH-only code also checked stdout, so we preserve that).
 */
export function isIdempotent(
  res: VirshResult,
  needles: readonly string[],
): boolean {
  return includesAny(res.stderr, needles) || includesAny(res.stdout, needles);
}

/**
 * Mask libvirt graphics (VNC/SPICE) passwords before text is written to a log.
 * Replaces `passwd='…'` / `passwd="…"` with `passwd='***'` (quote style
 * preserved). Anchored to the literal `passwd=` so the non-secret
 * `passwdValidTo='…'` expiry timestamp is left intact. Scope is graphics
 * passwords only — storage-auth secrets (iSCSI/RBD/CHAP, <secret>) are NOT
 * covered here (tracked separately). Stored dumpxml data is intentionally NOT
 * redacted; treat those data artifacts as sensitive.
 */
export function redactSecrets(text: string): string {
  return text.replace(/\bpasswd=(['"]).*?\1/g, "passwd=$1***$1");
}

const decoder = new TextDecoder();

async function run(
  command: string,
  args: string[],
  stdin?: string,
): Promise<VirshResult> {
  // @ts-ignore Deno global is available at bundle/runtime.
  const proc = new Deno.Command(command, {
    args,
    stdin: stdin === undefined ? "null" : "piped",
    stdout: "piped",
    stderr: "piped",
  });
  if (stdin === undefined) {
    const out = await proc.output();
    return {
      code: out.code,
      stdout: decoder.decode(out.stdout),
      stderr: decoder.decode(out.stderr),
    };
  }
  const child = proc.spawn();
  const writer = child.stdin.getWriter();
  await writer.write(new TextEncoder().encode(stdin));
  await writer.close();
  const out = await child.output();
  return {
    code: out.code,
    stdout: decoder.decode(out.stdout),
    stderr: decoder.decode(out.stderr),
  };
}

/**
 * Run a virsh subcommand and return its result WITHOUT throwing on a non-zero
 * exit. Use when the caller inspects the exit code / stderr (e.g. idempotent
 * "already active" / "domain is not running" handling).
 */
export function virshTry(
  conn: LibvirtConn,
  argv: string[],
): Promise<VirshResult> {
  const { command, args } = buildInvocation(conn, argv);
  return run(command, args);
}

/**
 * Run a virsh subcommand and throw on a non-zero exit (stderr in the message).
 * Use for commands where any failure is an error.
 */
export async function virsh(
  conn: LibvirtConn,
  argv: string[],
): Promise<VirshResult> {
  const res = await virshTry(conn, argv);
  if (res.code !== 0) {
    throw new Error(
      `virsh ${argv[0] ?? ""} failed (exit ${res.code}): ${
        (res.stderr || res.stdout).slice(-500)
      }`,
    );
  }
  return res;
}

/**
 * Run a NON-virsh command on the remote host over ssh (e.g. `ip route` for
 * host.addRoute). SSH-only: throws in local mode because there is no remote
 * shell to target. Every token is shell-quoted.
 */
export async function runSshRaw(
  conn: LibvirtConn,
  argv: string[],
): Promise<VirshResult> {
  const { command, args } = buildSshRaw(conn, argv);
  return await run(command, args);
}

/**
 * Define a libvirt object from XML via `virsh <verb> <source>`. The XML is fed
 * to virsh without ever passing through a shell: local mode writes it to a
 * race-safe temp file (Deno.makeTempFile) and removes it afterwards; SSH mode
 * streams it to `virsh <verb> /dev/stdin` over the ssh connection's stdin (no
 * temp file, no heredoc delimiter, no predictable-path race). `verb` is e.g.
 * "define" or "net-define". Throws on a non-zero exit.
 */
export async function defineXml(
  conn: LibvirtConn,
  verb: string,
  xml: string,
): Promise<VirshResult> {
  if (!conn.host) {
    // @ts-ignore Deno global is available at bundle/runtime.
    const tmp: string = await Deno.makeTempFile({
      prefix: "swamp-libvirt-",
      suffix: ".xml",
    });
    try {
      // @ts-ignore Deno global is available at bundle/runtime.
      await Deno.writeTextFile(tmp, xml);
      const { command, args } = buildInvocation(conn, [verb, tmp]);
      const res = await run(command, args);
      if (res.code !== 0) {
        throw new Error(
          `virsh ${verb} failed (exit ${res.code}): ${
            (res.stderr || res.stdout).slice(-500)
          }`,
        );
      }
      return res;
    } finally {
      try {
        // @ts-ignore Deno global is available at bundle/runtime.
        await Deno.remove(tmp);
      } catch {
        // best-effort cleanup
      }
    }
  }
  const { command, args } = buildInvocation(conn, [verb, "/dev/stdin"]);
  const res = await run(command, args, xml);
  if (res.code !== 0) {
    throw new Error(
      `virsh ${verb} failed (exit ${res.code}): ${
        (res.stderr || res.stdout).slice(-500)
      }`,
    );
  }
  return res;
}
