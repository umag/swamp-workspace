// Connection helpers shared across the @magistr/libvirt models.
//
// Two transports, selected per call from the model's globalArgs:
//   - SSH mode       (globalArgs.host set): runs `virsh` on the remote host
//     over ssh — no local libvirt client needed. Host keys follow
//     `hostKeyPolicy`: "accept-new" (default, TOFU against the runner's
//     known_hosts) or "strict" (StrictHostKeyChecking=yes against ONLY the
//     definition's `knownHosts` lines, written to a per-call 0600 temp file).
//     Calls share one ssh connection (ControlMaster) unless `multiplex` is
//     false; `port`, `identityFile`, `jumpHost`, `sshConfig` and `become`
//     (`sudo -n` on the hypervisor) shape the invocation. ssh's own exit
//     code 255 throws `SshConnectionError`, so a dropped connection is never
//     read as a virsh result.
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
  /** SSH port (SSH mode only; default: ssh's own). */
  port?: number;
  /** Private key file passed to ssh `-i` with IdentitiesOnly=yes. */
  identityFile?: string;
  /** Bastion passed to ssh `-J`. */
  jumpHost?: string;
  /** Extra ssh_config settings, each passed as `-o Key=Value`. */
  sshConfig?: Record<string, string>;
  /** Run remote commands under `sudo -n` (SSH mode only). */
  become?: boolean;
  /** Share one ssh connection across calls (SSH mode only; default true). */
  multiplex?: boolean;
}

/** Per-call ssh state built by `withSsh`. */
export interface SshCallContext {
  /** Temp known_hosts file under hostKeyPolicy "strict". */
  knownHostsFile?: string;
  /** ControlPath socket for connection sharing; absent = no sharing. */
  controlPath?: string;
}

/**
 * ssh itself failed (exit 255: unreachable host, refused auth, rejected host
 * key, dropped connection). Thrown instead of returning the result so that a
 * caller matching virsh stderr never reads a transport failure as a virsh
 * answer (e.g. "domain not found" -> idempotent no-op).
 */
export class SshConnectionError extends Error {
  constructor(target: string, stderr: string) {
    super(
      `ssh to ${target} failed (exit 255), the connection failed or the remote command was killed by a signal: ${
        stderr.trim().slice(-500) || "no stderr"
      }`,
    );
    this.name = "SshConnectionError";
  }
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

// ssh_config keys `sshConfig` may set: connection tuning only. An allowlist,
// because many other keys undo the guarantees here — VerifyHostKeyDNS and
// HostKeyAlias get past hostKeyPolicy "strict", ProxyCommand / LocalCommand
// run local commands, SessionType / StdinNull / RemoteCommand change what
// runs, ForwardAgent hands the agent to the hypervisor. Keys this module sets
// itself (ConnectTimeout, BatchMode, host-key and Control* keys) are left out
// too: ssh keeps the first value, so a second one would be silently ignored.
// Matched case-insensitively, as ssh does.
const ALLOWED_SSH_CONFIG_KEYS = [
  "AddressFamily",
  "Ciphers",
  "Compression",
  "ConnectionAttempts",
  "HostKeyAlgorithms",
  "IPQoS",
  "KexAlgorithms",
  "LogLevel",
  "MACs",
  "PubkeyAcceptedAlgorithms",
  "ServerAliveCountMax",
  "ServerAliveInterval",
  "TCPKeepAlive",
];

/** Why `key=value` is not an allowed `sshConfig` entry, or null. Pure. */
export function sshConfigProblem(key: string, value: string): string | null {
  if (
    !ALLOWED_SSH_CONFIG_KEYS.some((k) => k.toLowerCase() === key.toLowerCase())
  ) {
    return `sshConfig may not set ${JSON.stringify(key)}; allowed: ${
      ALLOWED_SSH_CONFIG_KEYS.join(", ")
    }`;
  }
  if (CONTROL_RE.test(value) || /\s/.test(value) || value === "") {
    return `sshConfig ${key} value must be one non-empty word`;
  }
  return null;
}

// A jump host list `[user@]host[:port][,…]`: no hop may start with `-`, or
// ssh would read it as an option in the ProxyJump command it builds.
function jumpHostOk(s: string): boolean {
  return /^[A-Za-z0-9_.@:,[\]-]+$/.test(s) &&
    s.split(",").every((hop) => hop !== "" && !hop.startsWith("-"));
}

/**
 * Global arguments shared by every libvirt model for how ssh reaches the
 * hypervisor (SSH mode only). Spread into each model's `GlobalArgsSchema`
 * next to `SshHostKeyArgs`.
 */
export const SshTransportArgs = {
  port: z.number().int().min(1).max(65535).optional().describe(
    "SSH port (SSH mode only). Default: ssh's own (22 or ~/.ssh/config).",
  ),
  identityFile: z.string().min(1).refine(
    (s) => !CONTROL_RE.test(s) && !s.includes("%"),
    {
      message: "control characters and % (an ssh token) are not allowed",
    },
  ).optional().describe(
    "Private key file for ssh `-i` (SSH mode only). Sets IdentitiesOnly=yes so only this key is offered.",
  ),
  jumpHost: z.string().refine(jumpHostOk, {
    message:
      "a comma-separated [user@]host[:port] list; no hop may start with '-'",
  }).optional().describe(
    "Bastion for ssh `-J`, e.g. `user@bastion:2222` (SSH mode only).",
  ),
  sshConfig: z.record(z.string(), z.string()).superRefine((rec, ctx) => {
    for (const [k, v] of Object.entries(rec)) {
      const problem = sshConfigProblem(k, v);
      if (problem) {
        ctx.addIssue({ code: "custom", message: problem, path: [k] });
      }
    }
  }).optional().describe(
    `Extra ssh_config settings passed as \`-o Key=Value\` (SSH mode only), e.g. {"ServerAliveInterval": "15"}. Allowed keys: ${
      ALLOWED_SSH_CONFIG_KEYS.join(", ")
    }.`,
  ),
  become: z.boolean().default(false).describe(
    "Run virsh and other remote commands under `sudo -n` (SSH mode only; needs passwordless sudo for the SSH user).",
  ),
  multiplex: z.boolean().default(true).describe(
    "Share one ssh connection across the virsh calls of a run (ControlMaster=auto, ControlPersist=30s; SSH mode only). Set false to open a new connection per call.",
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
 * Reject transport settings that would be silently ignored or that try to
 * override a managed ssh_config key, BEFORE any process starts (fail closed).
 * Re-checks what the zod schema checks, because a definition built from
 * another model's output reaches here too. Pure.
 */
export function checkSshTransportConfig(conn: LibvirtConn): void {
  if (!conn.host) {
    const set = [
      conn.port !== undefined && "port",
      conn.identityFile !== undefined && "identityFile",
      conn.jumpHost !== undefined && "jumpHost",
      conn.sshConfig !== undefined && "sshConfig",
      conn.become && "become",
    ].filter(Boolean);
    if (set.length > 0) {
      throw new Error(
        `${
          set.join(", ")
        } applies to SSH mode only (set \`host\`). In local/URI mode put ssh settings in the runner's ~/.ssh/config or the qemu+ssh:// URI.`,
      );
    }
    return;
  }
  // ssh reads a leading `-` in the destination as an option.
  for (const [name, v] of [["host", conn.host], ["user", conn.user]] as const) {
    if (
      v !== undefined &&
      (v.startsWith("-") || /[\s@]/.test(v) || CONTROL_RE.test(v))
    ) {
      throw new Error(
        `${name} ${
          JSON.stringify(v)
        } is not a valid ssh ${name}: no leading '-', whitespace, '@' or control characters.`,
      );
    }
  }
  for (const [k, v] of Object.entries(conn.sshConfig ?? {})) {
    const problem = sshConfigProblem(k, v);
    if (problem) throw new Error(problem);
  }
  if (conn.jumpHost !== undefined && !jumpHostOk(conn.jumpHost)) {
    throw new Error(
      "jumpHost must be a comma-separated [user@]host[:port] list; no hop may start with '-'.",
    );
  }
  if (
    conn.identityFile !== undefined &&
    (conn.identityFile.includes("%") || CONTROL_RE.test(conn.identityFile))
  ) {
    throw new Error(
      "identityFile may not contain % (an ssh token) or control characters.",
    );
  }
}

/**
 * The connection options after the host-key set: port, key, bastion, extra
 * ssh_config, then connection sharing. ssh keeps the FIRST value it sees for a
 * setting, so the host-key set always comes before these. Pure.
 */
function transportOptions(conn: LibvirtConn, ctx: SshCallContext): string[] {
  const opts: string[] = [];
  if (conn.port !== undefined) opts.push("-p", String(conn.port));
  if (conn.identityFile) {
    opts.push("-i", conn.identityFile, "-o", "IdentitiesOnly=yes");
  }
  if (conn.jumpHost) opts.push("-J", conn.jumpHost);
  for (const [k, v] of Object.entries(conn.sshConfig ?? {})) {
    opts.push("-o", `${k}=${v}`);
  }
  if (ctx.controlPath) {
    opts.push(
      "-o",
      "ControlMaster=auto",
      "-o",
      `ControlPath=${ctx.controlPath}`,
      "-o",
      "ControlPersist=30",
      // A reused connection skips ConnectTimeout; keepalives bound how long a
      // call waits on a master whose TCP link died silently (~10 s). After
      // sshConfig, so a user value wins.
      "-o",
      "ServerAliveInterval=5",
      "-o",
      "ServerAliveCountMax=2",
    );
  }
  return opts;
}

/**
 * The options for an ssh invocation: the host-key set, then
 * `transportOptions`. Default / "accept-new" uses the original hardened set.
 * "strict" needs the per-call known_hosts file (see `withSsh`) and pins ONLY
 * it: StrictHostKeyChecking=yes, UserKnownHostsFile=<file>,
 * GlobalKnownHostsFile=/dev/null (no system-wide key can satisfy the check),
 * UpdateHostKeys=no. Pure; throws if strict has no usable file (never falls
 * back to accept-new).
 */
export function sshOptions(
  conn: LibvirtConn,
  ctx: SshCallContext = {},
): string[] {
  return [
    ...hostKeyOptions(conn, ctx.knownHostsFile),
    ...transportOptions(conn, ctx),
  ];
}

function hostKeyOptions(
  conn: LibvirtConn,
  knownHostsFile: string | undefined,
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

// One 0700 directory per process for ControlMaster sockets, created on first
// use and re-checked on every call (see ownPrivateDir). Under /tmp because a
// unix socket path is limited to ~104 bytes and macOS's $TMPDIR alone is ~50.
// Removed at normal process exit (not on SIGTERM/SIGKILL, so a long-lived
// serve or worker leaves one empty directory per process); idle masters exit
// on their own after ControlPersist.
let controlDir: Promise<string | null> | undefined;

// sun_path is 104 bytes on macOS/BSD (108 on Linux), including the NUL.
const MAX_SOCKET_PATH = 103;

function sharedControlDir(): Promise<string | null> {
  controlDir = (async () => {
    const prev = await controlDir;
    if (prev && await ownPrivateDir(prev)) return prev;
    try {
      // @ts-ignore Deno global is available at bundle/runtime.
      const dir: string = await Deno.makeTempDir({
        dir: "/tmp",
        prefix: "swamp-libvirt-",
      });
      if (!SAFE_KNOWN_HOSTS_PATH_RE.test(dir) || !await ownPrivateDir(dir)) {
        return null;
      }
      globalThis.addEventListener?.("unload", () => {
        try {
          // @ts-ignore Deno global is available at bundle/runtime.
          Deno.removeSync(dir, { recursive: true });
        } catch {
          // best-effort cleanup
        }
      });
      return dir;
    } catch {
      return null; // no sharing; every call opens its own connection
    }
  })();
  return controlDir;
}

/**
 * True if `dir` is a real directory (not a symlink) owned by this process's
 * user with mode 0700. Checked on every call: ssh does not check who owns a
 * mux socket, so if a long-lived process's directory is removed (tmp reaper)
 * and another local user recreates the name, calls must not reach their
 * socket. A failed check makes a fresh directory.
 */
async function ownPrivateDir(dir: string): Promise<boolean> {
  try {
    // @ts-ignore Deno global is available at bundle/runtime.
    const st = await Deno.lstat(dir);
    // @ts-ignore Deno global is available at bundle/runtime.
    const uid = Deno.uid();
    return st.isDirectory && !st.isSymlink && st.uid === uid &&
      st.mode !== null && (st.mode & 0o777) === 0o700;
  } catch {
    return false;
  }
}

/**
 * ControlMaster socket file name: 16 hex chars of a SHA-256 over everything
 * that shapes the connection (target, port, jump host) AND its security
 * settings (host-key policy, pinned keys, identity file, extra ssh_config), so
 * a call under hostKeyPolicy "strict" can never ride a master opened under
 * "accept-new" or with other keys. Used instead of ssh's 40-char `%C`, which
 * with the 17-char suffix ssh adds while binding overflows the ~104-byte unix
 * socket path limit. Exported for tests.
 */
export async function controlTag(conn: LibvirtConn): Promise<string> {
  const material = JSON.stringify([
    conn.user || "root",
    conn.host ?? "",
    conn.port ?? 0,
    conn.jumpHost ?? "",
    conn.hostKeyPolicy ?? "accept-new",
    conn.knownHosts ?? [],
    conn.identityFile ?? "",
    conn.sshConfig ?? {},
  ]);
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(material),
  );
  return Array.from(new Uint8Array(digest).slice(0, 8))
    .map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Run `fn` with the per-call ssh state. Checks the config first (fail closed,
 * no I/O on error). Local mode calls `fn({})`. SSH mode adds the shared
 * ControlPath unless `multiplex` is false. Under "strict" it also creates a
 * race-safe temp known_hosts file (Deno.makeTempFile), chmods it 0600 BEFORE
 * writing the validated lines, and removes it in `finally` — also when `fn`
 * throws.
 */
export async function withSsh<T>(
  conn: LibvirtConn,
  fn: (ctx: SshCallContext) => Promise<T>,
): Promise<T> {
  checkHostKeyConfig(conn);
  checkSshTransportConfig(conn);
  if (!conn.host) return await fn({});
  let controlPath: string | undefined;
  if (conn.multiplex !== false) {
    const dir = await sharedControlDir();
    const path = dir && `${dir}/${await controlTag(conn)}`;
    // ssh binds `<path>.<17 random chars>` first; stay under the limit.
    if (path && path.length + 18 <= MAX_SOCKET_PATH) controlPath = path;
  }
  if (conn.hostKeyPolicy !== "strict") return await fn({ controlPath });
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
    return await fn({ knownHostsFile: tmp, controlPath });
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

/** `user@host` as ssh receives it. */
export function sshTarget(conn: LibvirtConn): string {
  return `${conn.user || "root"}@${conn.host}`;
}

/**
 * The ssh invocation running `argv` on the hypervisor: every token
 * shell-quoted for the remote login shell, under `sudo -n` when `become`.
 */
function sshInvocation(
  conn: LibvirtConn,
  argv: string[],
  ctx: SshCallContext,
): Invocation {
  const remote = [...(conn.become ? ["sudo", "-n"] : []), ...argv]
    .map(shellQuote).join(" ");
  return {
    command: "ssh",
    args: [...sshOptions(conn, ctx), "--", sshTarget(conn), remote],
  };
}

/**
 * Build the ssh invocation for a NON-virsh remote command (e.g. `ip route`).
 * Pure; throws in local mode because there is no remote shell to target. Every
 * token is shell-quoted so an injected token stays a single argument.
 * `ctx.knownHostsFile` is required under hostKeyPolicy "strict" (see
 * sshOptions).
 */
export function buildSshRaw(
  conn: LibvirtConn,
  argv: string[],
  ctx: SshCallContext = {},
): Invocation {
  if (!conn.host) {
    throw new Error(
      "This operation requires SSH host mode — set the `host` global argument.",
    );
  }
  return sshInvocation(conn, argv, ctx);
}

/**
 * Build the command + argv for a virsh subcommand without running it. Pure.
 * Local mode -> {command:"virsh", args:[...uriFlag, ...argv]} (argv passed
 * directly to Deno.Command, no shell). SSH mode -> {command:"ssh", args:[
 * ...sshOpts, user@host, "<every token shell-quoted and space-joined>"]}.
 * `ctx.knownHostsFile` is required under hostKeyPolicy "strict" (see
 * sshOptions).
 */
export function buildInvocation(
  conn: LibvirtConn,
  argv: string[],
  ctx: SshCallContext = {},
): Invocation {
  const full = [...uriFlag(conn), ...argv];
  if (!conn.host) {
    return { command: "virsh", args: full };
  }
  return sshInvocation(conn, ["virsh", ...full], ctx);
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
  stdin?: string | Uint8Array,
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
  await writer.write(
    typeof stdin === "string" ? new TextEncoder().encode(stdin) : stdin,
  );
  await writer.close();
  const out = await child.output();
  return {
    code: out.code,
    stdout: decoder.decode(out.stdout),
    stderr: decoder.decode(out.stderr),
  };
}

/**
 * Throw `SshConnectionError` when ssh itself failed (exit 255) in SSH mode.
 * virsh, sudo and the other remote commands used here never exit 255, so the
 * code means the command did not run. Exported for the console capture and
 * tests.
 */
export function assertSshReached(conn: LibvirtConn, res: VirshResult): void {
  if (conn.host && res.code === 255) {
    throw new SshConnectionError(sshTarget(conn), res.stderr);
  }
}

/** Run an invocation built under `withSsh` and check ssh reached the host. */
async function runChecked(
  conn: LibvirtConn,
  inv: Invocation,
  stdin?: string | Uint8Array,
): Promise<VirshResult> {
  const res = await run(inv.command, inv.args, stdin);
  assertSshReached(conn, res);
  return res;
}

/**
 * Run a virsh subcommand and return its result WITHOUT throwing on a non-zero
 * exit. Use when the caller inspects the exit code / stderr (e.g. idempotent
 * "already active" / "domain is not running" handling). Still throws
 * `SshConnectionError` when ssh could not reach the hypervisor.
 */
export function virshTry(
  conn: LibvirtConn,
  argv: string[],
): Promise<VirshResult> {
  return withSsh(
    conn,
    (ctx) => runChecked(conn, buildInvocation(conn, argv, ctx)),
  );
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
  stdin?: string | Uint8Array,
): Promise<VirshResult> {
  return await withSsh(
    conn,
    (ctx) => runChecked(conn, buildSshRaw(conn, argv, ctx), stdin),
  );
}

/**
 * Run a NON-virsh command on the hypervisor: over ssh in SSH mode (as
 * runSshRaw), or directly on the swamp host in local mode (argv straight to
 * Deno.Command, no shell). `stdin` may be text or bytes. Does not throw on a
 * non-zero exit (only on ssh exit 255). Used by vm.provision for qemu-img,
 * curl, sha256sum and file writes.
 */
export async function runOnHost(
  conn: LibvirtConn,
  argv: string[],
  stdin?: string | Uint8Array,
): Promise<VirshResult> {
  if (conn.host) return await runSshRaw(conn, argv, stdin);
  checkHostKeyConfig(conn);
  checkSshTransportConfig(conn);
  const [command, ...args] = argv;
  if (!command) throw new Error("runOnHost: empty argv");
  return await run(command, args, stdin);
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
  checkSshTransportConfig(conn);
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
  const res = await withSsh(
    conn,
    (ctx) =>
      runChecked(conn, buildInvocation(conn, [verb, "/dev/stdin"], ctx), xml),
  );
  if (res.code !== 0) {
    throw new Error(
      `virsh ${verb} failed (exit ${res.code}): ${
        (res.stderr || res.stdout).slice(-500)
      }`,
    );
  }
  return res;
}
