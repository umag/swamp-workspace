// Connection helpers shared across the @magistr/libvirt models.
//
// Two transports, selected per call from the model's globalArgs:
//   - SSH mode       (globalArgs.host set): runs `virsh` on the remote host
//     over ssh — no local libvirt client needed. Host keys follow
//     `hostKeyPolicy`: "accept-new" (default, TOFU against the runner's
//     known_hosts) or "strict" (StrictHostKeyChecking=yes against ONLY the
//     definition's `knownHosts` lines, written to a per-call 0600 temp file).
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

import { z } from "npm:zod@4";

/** SSH host-key verification policy (SSH mode only). */
export type HostKeyPolicy = "accept-new" | "strict";

/** Connection target value object, taken from a model's `globalArgs`. */
export interface LibvirtConn {
  /** SSH host/IP. If set, virsh runs on this host over ssh. */
  host?: string;
  /** SSH username (SSH mode only; default root). */
  user?: string;
  /** Libvirt connection URI. Local mode defaults to qemu:///system. */
  uri?: string;
  /** Host-key policy (SSH mode only; default "accept-new"). */
  hostKeyPolicy?: HostKeyPolicy;
  /** OpenSSH known_hosts lines pinned under hostKeyPolicy "strict". */
  knownHosts?: string[];
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
// trust-on-first-use — pre-seed known_hosts (ssh-keyscan) out of band, or use
// hostKeyPolicy "strict" (below), to close that gap.
const SSH_OPTS = [
  "-o",
  "StrictHostKeyChecking=accept-new",
  "-o",
  "BatchMode=yes",
  "-o",
  "ConnectTimeout=10",
];

/**
 * Global arguments shared by every libvirt model for the SSH host-key policy.
 * Spread into each model's `GlobalArgsSchema` so the four models cannot
 * drift. `knownHosts` lines are validated at definition time here AND again
 * per call (`validateKnownHosts`), so a definition built from another model's
 * output is checked too.
 */
export const SshHostKeyArgs = {
  hostKeyPolicy: z.enum(["accept-new", "strict"]).default("accept-new")
    .describe(
      'SSH host-key policy (SSH mode only). "accept-new" (default): trust on first use against the runner\'s ~/.ssh/known_hosts and refuse a changed key. "strict": StrictHostKeyChecking=yes against ONLY the `knownHosts` lines — an unknown or mismatched key fails closed.',
    ),
  knownHosts: z.array(
    z.string().refine((l) => isKnownHostsLine(l), {
      message:
        "not a single OpenSSH known_hosts entry ([@cert-authority|@revoked] <hosts> <key-type> <base64-key> [comment]); control characters such as newlines are not allowed",
    }),
  ).optional().describe(
    'OpenSSH known_hosts lines for the hypervisor (e.g. output of `ssh-keyscan -t ed25519 <host>`). Required with hostKeyPolicy "strict"; only allowed with it.',
  ),
};

// One OpenSSH key-type token: ssh-ed25519, ssh-rsa, ecdsa-sha2-nistp256,
// sk-ssh-ed25519@openssh.com, *-cert-v01@openssh.com, …
const KEY_TYPE_RE = /^(?:ssh|ecdsa|sk)-[A-Za-z0-9@.+-]+$/;
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;
// Any C0 control character or DEL. Rejecting these (LF/CR above all) keeps a
// single supplied line from becoming several known_hosts entries.
// deno-lint-ignore no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f]/;

/**
 * True if `line` is exactly ONE OpenSSH known_hosts entry:
 * `[@cert-authority|@revoked] <host-patterns> <key-type> <base64-key>
 * [comment]`, fields separated by spaces, no control characters. Comment and
 * blank lines are rejected because they pin nothing. Pure.
 */
export function isKnownHostsLine(line: string): boolean {
  if (CONTROL_RE.test(line)) return false;
  const fields = line.trim().split(/ +/).filter((f) => f !== "");
  if (fields[0]?.startsWith("@")) {
    if (fields[0] !== "@cert-authority" && fields[0] !== "@revoked") {
      return false;
    }
    fields.shift();
  }
  const [hosts, keyType, key] = fields;
  if (!hosts || !keyType || !key) return false;
  if (hosts.startsWith("#") || hosts.startsWith("@")) return false;
  if (KEY_TYPE_RE.test(hosts)) return false; // key type where hosts belong
  return KEY_TYPE_RE.test(keyType) && BASE64_RE.test(key);
}

/**
 * Validate the `knownHosts` lines for hostKeyPolicy "strict" and return them
 * trimmed. Throws (fail closed) if the list is missing/empty or any line is
 * not a single valid known_hosts entry, naming the offending index. Pure.
 */
export function validateKnownHosts(lines: string[] | undefined): string[] {
  if (!lines || lines.length === 0) {
    throw new Error(
      "hostKeyPolicy 'strict' requires knownHosts — supply the hypervisor's OpenSSH known_hosts line(s) (e.g. from `ssh-keyscan -t ed25519 <host>`, verified out of band).",
    );
  }
  return lines.map((line, i) => {
    if (!isKnownHostsLine(line)) {
      throw new Error(
        `knownHosts[${i}] is not a single valid OpenSSH known_hosts entry ([@cert-authority|@revoked] <hosts> <key-type> <base64-key> [comment], no newlines or other control characters).`,
      );
    }
    return line.trim();
  });
}

/**
 * Reject host-key settings that would not do what they say, BEFORE any file
 * or process is created (fail closed). Pure.
 *  - "strict" in local/URI mode: virsh's own transport (qemu+ssh://) is not
 *    governed by these options, so pinning would silently not apply.
 *  - "strict" without valid knownHosts: nothing to pin against.
 *  - knownHosts without "strict": the lines would be ignored, pinning nothing.
 */
export function checkHostKeyConfig(conn: LibvirtConn): void {
  const strict = conn.hostKeyPolicy === "strict";
  if (strict && !conn.host) {
    throw new Error(
      "hostKeyPolicy 'strict' applies to SSH mode only (set `host`). In local/URI mode the libvirt URI transport handles host keys (configure them in the runner's ssh config, or via the `known_hosts=` URI parameter of the libssh/libssh2 transports).",
    );
  }
  if (strict) {
    validateKnownHosts(conn.knownHosts);
    return;
  }
  if (conn.knownHosts && conn.knownHosts.length > 0) {
    throw new Error(
      "knownHosts is set but hostKeyPolicy is not 'strict', so the keys would be ignored — set hostKeyPolicy: strict to pin them, or remove knownHosts.",
    );
  }
}

// A path ssh will read as ONE file name: ssh splits UserKnownHostsFile on
// whitespace and expands `%` tokens and a leading `~`.
const SAFE_KNOWN_HOSTS_PATH_RE = /^[A-Za-z0-9_.:\\/-]+$/;

/**
 * The `-o` options for an ssh invocation. Default / "accept-new" returns the
 * original hardened set unchanged. "strict" needs the per-call known_hosts
 * file (see `withHostKeys`) and pins ONLY it: StrictHostKeyChecking=yes,
 * UserKnownHostsFile=<file>, GlobalKnownHostsFile=/dev/null (no system-wide
 * key can satisfy the check), UpdateHostKeys=no. Pure; throws if strict has
 * no usable file (never falls back to accept-new).
 */
export function sshOptions(
  conn: LibvirtConn,
  knownHostsFile?: string,
): string[] {
  if (conn.hostKeyPolicy !== "strict") return SSH_OPTS;
  if (!knownHostsFile) {
    throw new Error(
      "hostKeyPolicy 'strict' needs a per-call known_hosts file; none was provided.",
    );
  }
  if (!SAFE_KNOWN_HOSTS_PATH_RE.test(knownHostsFile)) {
    throw new Error(
      `known_hosts temp path ${
        JSON.stringify(knownHostsFile)
      } contains characters ssh would split or expand — set TMPDIR to a plain path.`,
    );
  }
  return [
    "-o",
    "StrictHostKeyChecking=yes",
    "-o",
    `UserKnownHostsFile=${knownHostsFile}`,
    "-o",
    "GlobalKnownHostsFile=/dev/null",
    "-o",
    "UpdateHostKeys=no",
    "-o",
    "BatchMode=yes",
    "-o",
    "ConnectTimeout=10",
  ];
}

/**
 * Run `fn` with the known_hosts file the host-key policy needs. Checks the
 * config first (fail closed, no I/O on error). Local mode and "accept-new"
 * call `fn(undefined)`. "strict" creates a race-safe temp file
 * (Deno.makeTempFile), chmods it 0600 BEFORE writing the validated lines,
 * passes its path to `fn`, and removes it in `finally` — also when `fn`
 * throws.
 */
export async function withHostKeys<T>(
  conn: LibvirtConn,
  fn: (knownHostsFile: string | undefined) => Promise<T>,
): Promise<T> {
  checkHostKeyConfig(conn);
  if (!conn.host || conn.hostKeyPolicy !== "strict") return await fn(undefined);
  const lines = validateKnownHosts(conn.knownHosts);
  // @ts-ignore Deno global is available at bundle/runtime.
  const tmp: string = await Deno.makeTempFile({
    prefix: "swamp-libvirt-",
    suffix: ".known_hosts",
  });
  try {
    // @ts-ignore Deno global is available at bundle/runtime.
    if (Deno.build?.os !== "windows") await Deno.chmod(tmp, 0o600);
    // @ts-ignore Deno global is available at bundle/runtime.
    await Deno.writeTextFile(tmp, `${lines.join("\n")}\n`);
    return await fn(tmp);
  } finally {
    try {
      // @ts-ignore Deno global is available at bundle/runtime.
      await Deno.remove(tmp);
    } catch {
      // best-effort cleanup
    }
  }
}

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
 * `knownHostsFile` is required under hostKeyPolicy "strict" (see sshOptions).
 */
export function buildSshRaw(
  conn: LibvirtConn,
  argv: string[],
  knownHostsFile?: string,
): Invocation {
  if (!conn.host) {
    throw new Error(
      "This operation requires SSH host mode — set the `host` global argument.",
    );
  }
  const remote = argv.map(shellQuote).join(" ");
  const target = `${conn.user || "root"}@${conn.host}`;
  return {
    command: "ssh",
    args: [...sshOptions(conn, knownHostsFile), target, remote],
  };
}

/**
 * Build the command + argv for a virsh subcommand without running it. Pure.
 * Local mode -> {command:"virsh", args:[...uriFlag, ...argv]} (argv passed
 * directly to Deno.Command, no shell). SSH mode -> {command:"ssh", args:[
 * ...sshOpts, user@host, "<every token shell-quoted and space-joined>"]}.
 * `knownHostsFile` is required under hostKeyPolicy "strict" (see sshOptions).
 */
export function buildInvocation(
  conn: LibvirtConn,
  argv: string[],
  knownHostsFile?: string,
): Invocation {
  const full = [...uriFlag(conn), ...argv];
  if (!conn.host) {
    return { command: "virsh", args: full };
  }
  const remote = ["virsh", ...full].map(shellQuote).join(" ");
  const target = `${conn.user || "root"}@${conn.host}`;
  return {
    command: "ssh",
    args: [...sshOptions(conn, knownHostsFile), target, remote],
  };
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
  /**
   * `virsh net-start` on an already-active network. Deliberately shares the
   * "already active" substring with `poolAlreadyActive` — each set is anchored
   * to its own resource (see the doc comment above), so do NOT dedupe them.
   */
  networkAlreadyActive: ["already active"],
  /** `virsh net-destroy` on an inactive network ("network 'x' is not active"). */
  networkNotActive: ["is not active"],
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
  return withHostKeys(conn, (kh) => {
    const { command, args } = buildInvocation(conn, argv, kh);
    return run(command, args);
  });
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
  return await withHostKeys(conn, (kh) => {
    const { command, args } = buildSshRaw(conn, argv, kh);
    return run(command, args);
  });
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
  checkHostKeyConfig(conn);
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
  const res = await withHostKeys(conn, (kh) => {
    const { command, args } = buildInvocation(conn, [verb, "/dev/stdin"], kh);
    return run(command, args, xml);
  });
  if (res.code !== 0) {
    throw new Error(
      `virsh ${verb} failed (exit ${res.code}): ${
        (res.stderr || res.stdout).slice(-500)
      }`,
    );
  }
  return res;
}
