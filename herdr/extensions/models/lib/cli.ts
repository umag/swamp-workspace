/**
 * Transport for the herdr CLI: subprocess execution, response-envelope
 * parsing, and the small pure helpers the model builds argv from.
 *
 * herdr's socket-backed subcommands (`workspace`, `tab`, `pane`, `agent`,
 * `worktree`, `notification`, `api`) print one JSON envelope on stdout:
 *
 *   success: {"id":"cli:pane:get","result":{"type":"pane_info","pane":{…}}}
 *   failure: {"error":{"code":"not_git_worktree","message":"…"},"id":"…"}
 *
 * `pane read` / `agent read` are the exceptions — they print the captured
 * terminal text raw, with no envelope, which is why `herdrText` exists
 * alongside `herdrJson`.
 *
 * Every function that shells out takes the runner as its FIRST parameter so
 * tests can drive the model with a scripted fake and never spawn herdr.
 */

/** Result of one subprocess invocation. */
export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
}

/** Options for one subprocess invocation. */
export interface RunOptions {
  env?: Record<string, string>;
  timeoutMs?: number;
}

/**
 * The injectable process runner. Production code passes `defaultRunner`;
 * tests pass a scripted fake that records argv and answers from a table.
 */
export type CommandRunner = (
  cmd: string,
  args: string[],
  opts?: RunOptions,
) => Promise<RunResult>;

/** The default {@link CommandRunner}, backed by `Deno.Command`. */
export const defaultRunner: CommandRunner = async (cmd, args, opts = {}) => {
  const controller = new AbortController();
  const timeoutMs = opts.timeoutMs ?? 0;
  const timer = timeoutMs > 0
    ? setTimeout(() => controller.abort(), timeoutMs)
    : undefined;
  try {
    const child = new Deno.Command(cmd, {
      args,
      env: opts.env,
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
      signal: controller.signal,
    }).spawn();
    const { code, stdout, stderr } = await child.output();
    return {
      code,
      stdout: new TextDecoder().decode(stdout),
      stderr: new TextDecoder().decode(stderr),
      timedOut: controller.signal.aborted,
    };
  } catch (err) {
    if (controller.signal.aborted) {
      return { code: 124, stdout: "", stderr: "timed out", timedOut: true };
    }
    throw err;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
};

/** A herdr server reached over SSH instead of the local socket. */
export interface SshTarget {
  host: string;
  user: string;
  port: number;
  identityFile: string;
  /** herdr executable ON THE REMOTE HOST; empty falls back to `binary`. */
  binary: string;
  /** Extra `ssh` arguments, placed before the defaults so they win. */
  extraArgs: string[];
}

/** Connection settings shared by every herdr invocation. */
export interface HerdrConfig {
  binary: string;
  session: string;
  socketPath: string;
  timeoutMs: number;
  /** null runs herdr locally; a target runs it over ssh on another host. */
  ssh: SshTarget | null;
}

/** A herdr CLI failure, carrying the machine-readable code when there is one. */
export class HerdrError extends Error {
  readonly code: string;
  readonly exitCode: number;
  readonly argv: string[];

  constructor(
    message: string,
    opts: { code?: string; exitCode?: number; argv?: string[] } = {},
  ) {
    super(message);
    this.name = "HerdrError";
    this.code = opts.code ?? "cli_error";
    this.exitCode = opts.exitCode ?? 1;
    this.argv = opts.argv ?? [];
  }
}

/**
 * Environment overrides for a herdr invocation.
 *
 * Only the two knobs herdr documents are forwarded, and only when set — an
 * empty `session`/`socketPath` must NOT export an empty variable, because
 * herdr treats a set-but-empty `HERDR_SESSION` as a named session called "".
 * The parent environment is inherited so `PATH`/`HOME` still resolve.
 */
export function herdrEnv(cfg: HerdrConfig): Record<string, string> | undefined {
  const env: Record<string, string> = {};
  if (cfg.session) env.HERDR_SESSION = cfg.session;
  if (cfg.socketPath) env.HERDR_SOCKET_PATH = cfg.socketPath;
  return Object.keys(env).length > 0 ? env : undefined;
}

/** Reads one environment variable; injectable so tests never touch the real env. */
export type EnvGetter = (key: string) => string | undefined;

/** The default {@link EnvGetter}, backed by `Deno.env`. */
export const defaultEnvGet: EnvGetter = (key) => {
  try {
    return Deno.env.get(key);
  } catch {
    // No --allow-env: treat as unset rather than failing the whole method.
    return undefined;
  }
};

/** Where this process itself is running, when it runs inside a herdr pane. */
export interface SelfLocation {
  paneId: string;
  tabId: string;
  workspaceId: string;
  inHerdr: boolean;
}

/**
 * Resolve the caller's own pane from the `HERDR_*` variables herdr exports
 * into every pane process. This is what lets destructive methods refuse to
 * close the terminal that is driving them.
 */
export function readSelfLocation(envGet: EnvGetter): SelfLocation {
  const paneId = envGet("HERDR_PANE_ID") ?? "";
  const tabId = envGet("HERDR_TAB_ID") ?? "";
  const workspaceId = envGet("HERDR_WORKSPACE_ID") ?? "";
  return {
    paneId,
    tabId,
    workspaceId,
    inHerdr: Boolean(paneId || tabId || workspaceId),
  };
}

/** Nothing is "us" — the shape used whenever the self guard must not fire. */
const NO_SELF: SelfLocation = {
  paneId: "",
  tabId: "",
  workspaceId: "",
  inHerdr: false,
};

/**
 * The caller's own location AS SEEN BY THE TARGETED SERVER.
 *
 * `HERDR_PANE_ID` names a pane on the LOCAL server. Point the model at a
 * remote herdr and those ids describe a different machine's fleet — and
 * herdr numbers panes per session, so the local `w1:p4` and the remote
 * `w1:p4` are two unrelated panes that happen to share a string. Letting the
 * guard match there would refuse a legitimate remote close and skip a
 * legitimate remote prompt, so against a remote target there is no "self".
 */
export function selfLocationFor(
  cfg: HerdrConfig,
  envGet: EnvGetter,
): SelfLocation {
  return cfg.ssh ? NO_SELF : readSelfLocation(envGet);
}

/** Extract the first JSON object from CLI output, or null when there is none. */
export function extractEnvelope(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Not a complete JSON document — fall through to the raw-text path.
  }
  return null;
}

/** Bound a captured string to `maxBytes`, reporting whether it was cut. */
export function boundText(
  text: string,
  maxBytes: number,
): { text: string; bytes: number; truncated: boolean } {
  const encoded = new TextEncoder().encode(text);
  if (maxBytes <= 0 || encoded.length <= maxBytes) {
    return { text, bytes: encoded.length, truncated: false };
  }
  const cut = encoded.slice(0, maxBytes);
  // `fatal: false` drops a trailing partial code point instead of throwing.
  const decoded = new TextDecoder("utf-8", { fatal: false }).decode(cut)
    .replace(/�+$/, "");
  return { text: decoded, bytes: encoded.length, truncated: true };
}

/** First non-empty line of the combined streams — the best single-line error. */
function firstMeaningfulLine(...streams: string[]): string {
  for (const stream of streams) {
    for (const line of stream.split("\n")) {
      const trimmed = line.trim();
      if (trimmed) return trimmed;
    }
  }
  return "";
}

/**
 * Throw a {@link HerdrError} if the invocation failed, and return its parsed
 * `result` object when the command produced one.
 *
 * herdr prints its error envelope on stdout for socket failures but plain
 * `usage:` text on stderr for argument errors, so both streams are inspected
 * regardless of exit code. A successful command may legitimately print
 * nothing at all (`pane send-text`, `send-keys`, `run`), which is why the
 * result is optional here and required only by {@link parseEnvelope}.
 */
export function checkEnvelope(
  argv: string[],
  res: RunResult,
): Record<string, unknown> | null {
  const envelope = extractEnvelope(res.stdout) ?? extractEnvelope(res.stderr);
  const err = envelope?.error;
  if (err && typeof err === "object") {
    const e = err as Record<string, unknown>;
    throw new HerdrError(String(e.message ?? "herdr reported an error"), {
      code: typeof e.code === "string" ? e.code : "herdr_error",
      exitCode: res.code,
      argv,
    });
  }
  if (res.timedOut) {
    throw new HerdrError(`herdr ${argv.join(" ")} timed out`, {
      code: "timeout",
      exitCode: res.code,
      argv,
    });
  }
  if (res.code !== 0) {
    const detail = firstMeaningfulLine(res.stderr, res.stdout) ||
      `exit code ${res.code}`;
    throw new HerdrError(`herdr ${argv.join(" ")} failed: ${detail}`, {
      exitCode: res.code,
      argv,
    });
  }
  const result = envelope?.result;
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    return null;
  }
  return result as Record<string, unknown>;
}

/**
 * Turn a finished herdr invocation into its `result` object, or throw a
 * {@link HerdrError} — including when the command succeeded but printed no
 * parsable envelope, which for a result-bearing subcommand means herdr's
 * output contract changed.
 */
export function parseEnvelope(
  argv: string[],
  res: RunResult,
): Record<string, unknown> {
  const result = checkEnvelope(argv, res);
  if (!result) {
    const detail = firstMeaningfulLine(res.stdout, res.stderr) ||
      "empty output";
    throw new HerdrError(
      `herdr ${argv.join(" ")} returned no JSON result: ${detail}`,
      { code: "unparsable_response", exitCode: res.code, argv },
    );
  }
  return result;
}

// ── invocation: local argv vs. a remote shell command ────────────────────────

/**
 * POSIX-quote one argument for a remote shell.
 *
 * Locally, arguments reach herdr through `Deno.Command`'s argv and no shell
 * ever sees them. Over SSH there is ALWAYS a login shell on the far side that
 * re-splits whatever string we send, so every element has to be quoted or a
 * prompt containing `;` becomes a command on the remote host.
 *
 * Everything is wrapped unconditionally — no "looks safe, skip it" fast path,
 * because that predicate is exactly where quoting bugs live. Inside single
 * quotes POSIX sh treats every byte literally (newlines included); the only
 * character that needs work is the single quote itself, which is closed,
 * escaped, and reopened.
 */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/** How one herdr invocation is actually executed. */
export interface Invocation {
  cmd: string;
  args: string[];
  env?: Record<string, string>;
}

/**
 * Resolve a herdr argv into the process this host will actually run.
 *
 * Local: herdr is executed directly, with `HERDR_*` set in the child's
 * environment. Remote: `ssh` is executed, and the whole herdr command —
 * environment included, since the local child env means nothing on another
 * machine — is folded into a single quoted shell command string.
 */
export function buildInvocation(
  cfg: HerdrConfig,
  argv: string[],
): Invocation {
  if (!cfg.ssh) {
    return { cmd: cfg.binary, args: argv, env: herdrEnv(cfg) };
  }
  const target = cfg.ssh.user
    ? `${cfg.ssh.user}@${cfg.ssh.host}`
    : cfg.ssh.host;
  if (target.startsWith("-")) {
    throw new HerdrError(
      `Invalid ssh target ${JSON.stringify(target)} — must not start with "-"`,
      { code: "invalid_argument" },
    );
  }

  const args: string[] = [];
  // Caller options come FIRST: ssh keeps the first value it obtains for any
  // given option, so this is what lets a user override the defaults below.
  args.push(...cfg.ssh.extraArgs);
  // Never sit on a password/passphrase prompt — that would burn the whole
  // timeout on a connection that is never going to succeed unattended.
  args.push("-o", "BatchMode=yes");
  args.push("-o", "ConnectTimeout=10");
  if (cfg.ssh.port > 0) args.push("-p", String(cfg.ssh.port));
  if (cfg.ssh.identityFile) args.push("-i", cfg.ssh.identityFile);
  args.push(target, remoteCommand(cfg, argv));
  return { cmd: "ssh", args };
}

/** The single shell command string sent to the remote host. */
export function remoteCommand(cfg: HerdrConfig, argv: string[]): string {
  const parts: string[] = [];
  const env = herdrEnv(cfg);
  if (env) {
    parts.push("env");
    for (const [key, value] of Object.entries(env)) {
      parts.push(shellQuote(`${key}=${value}`));
    }
  }
  parts.push(shellQuote(cfg.ssh?.binary || cfg.binary));
  for (const arg of argv) parts.push(shellQuote(arg));
  return parts.join(" ");
}

/** Execute one herdr argv, local or remote, and hand back the raw result. */
async function invoke(
  run: CommandRunner,
  cfg: HerdrConfig,
  argv: string[],
  timeoutMs: number | undefined,
): Promise<RunResult> {
  const invocation = buildInvocation(cfg, argv);
  return await run(invocation.cmd, invocation.args, {
    env: invocation.env,
    timeoutMs: timeoutMs ?? cfg.timeoutMs,
  });
}

/** Run a herdr subcommand and return its parsed `result` object. */
export async function herdrJson(
  run: CommandRunner,
  cfg: HerdrConfig,
  argv: string[],
  opts: { timeoutMs?: number } = {},
): Promise<Record<string, unknown>> {
  return parseEnvelope(argv, await invoke(run, cfg, argv, opts.timeoutMs));
}

/**
 * Run a herdr subcommand that prints raw text (`pane read`, `agent read`,
 * `status`) and return stdout. Errors still arrive as a JSON envelope, so
 * those are routed through the same failure path.
 */
export async function herdrText(
  run: CommandRunner,
  cfg: HerdrConfig,
  argv: string[],
  opts: { timeoutMs?: number } = {},
): Promise<string> {
  const res = await invoke(run, cfg, argv, opts.timeoutMs);
  checkEnvelope(argv, res);
  return res.stdout;
}

/**
 * Run a herdr subcommand that succeeds silently (`pane send-text`,
 * `send-keys`, `run`). Returns the parsed result when herdr printed one and
 * `null` when it printed nothing — both are success.
 */
export async function herdrOk(
  run: CommandRunner,
  cfg: HerdrConfig,
  argv: string[],
  opts: { timeoutMs?: number } = {},
): Promise<Record<string, unknown> | null> {
  return checkEnvelope(argv, await invoke(run, cfg, argv, opts.timeoutMs));
}

/** Human-readable name for whichever herdr this config talks to. */
export function targetLabel(cfg: HerdrConfig): string {
  if (!cfg.ssh) return "local";
  const host = cfg.ssh.user ? `${cfg.ssh.user}@${cfg.ssh.host}` : cfg.ssh.host;
  return cfg.ssh.port > 0 ? `${host}:${cfg.ssh.port}` : host;
}

// ── argv builders ────────────────────────────────────────────────────────────

/** Append `--flag value` when the value is a non-empty string. */
export function pushFlag(
  argv: string[],
  flag: string,
  value: string | undefined,
): string[] {
  if (value !== undefined && value !== "") argv.push(flag, value);
  return argv;
}

/** Append a repeatable `--flag k=v` for every entry of `values`. */
export function pushRepeated(
  argv: string[],
  flag: string,
  values: readonly string[],
): string[] {
  for (const value of values) {
    if (value !== "") argv.push(flag, value);
  }
  return argv;
}

/** Append `--focus` or `--no-focus` — herdr defaults to not focusing. */
export function pushFocus(argv: string[], focus: boolean): string[] {
  argv.push(focus ? "--focus" : "--no-focus");
  return argv;
}

/**
 * Reject `KEY=VALUE` pairs herdr's `--env` flag cannot express.
 *
 * A pair with no `=` would be read by herdr as the *next* positional
 * argument, silently shifting every following flag — so it is refused rather
 * than passed through.
 */
export function assertEnvPairs(pairs: readonly string[]): void {
  for (const pair of pairs) {
    const eq = pair.indexOf("=");
    if (eq <= 0) {
      throw new HerdrError(
        `Invalid env entry ${JSON.stringify(pair)} — expected KEY=VALUE`,
        { code: "invalid_argument" },
      );
    }
  }
}

/**
 * Reject ids/targets that would be read as flags.
 *
 * herdr ids look like `w1:p4` and agent names are user-chosen; a value
 * starting with `-` would be parsed as an option by herdr's own argv parser,
 * turning "read this pane" into "pass an unknown flag" — or worse, into a
 * different flag that happens to exist.
 */
export function assertTarget(value: string, what = "target"): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new HerdrError(`Empty ${what}`, { code: "invalid_argument" });
  }
  if (trimmed.startsWith("-")) {
    throw new HerdrError(
      `Invalid ${what} ${JSON.stringify(value)} — must not start with "-"`,
      { code: "invalid_argument" },
    );
  }
  return trimmed;
}

// ── `herdr status` (plain text, not an envelope) ──────────────────────────────

/**
 * Parse the indented block format `herdr status` prints:
 *
 *   client:
 *     version: 0.8.0
 *   server:
 *     status: running
 *
 * Returns `{ client: { version: "0.8.0" }, server: { status: "running" } }`.
 * Unknown sections are preserved, so a future herdr release adding one does
 * not break the parse.
 */
export function parseStatusBlocks(
  text: string,
): Record<string, Record<string, string>> {
  const out: Record<string, Record<string, string>> = {};
  let section = "";
  for (const rawLine of text.split("\n")) {
    const line = rawLine.replace(/\s+$/, "");
    if (!line.trim()) continue;
    const isIndented = /^\s/.test(line);
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    const key = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim();
    if (!isIndented) {
      section = key;
      if (!out[section]) out[section] = {};
      // `key: value` on an unindented line (no children) is still a datum.
      if (value) out[section]._ = value;
      continue;
    }
    if (!section) continue;
    out[section][key] = value;
  }
  return out;
}

/** herdr prints booleans as `yes`/`no`; anything else is treated as false. */
export function yesNo(value: string | undefined): boolean {
  return value === "yes" || value === "true";
}
