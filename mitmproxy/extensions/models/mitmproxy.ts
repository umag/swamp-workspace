/**
 * `@magistr/mitmproxy` — install, run and inspect a local mitmproxy from swamp.
 *
 * - `install`     — `uv tool install --no-build mitmproxy` (wheels only).
 * - `status`      — version, process, listener and CA certificate state.
 * - `start`       — run mitmdump / mitmweb in the background (idempotent).
 * - `stop`        — stop the background proxy (idempotent).
 * - `flows`       — summarise captured flows, optionally by filter expression.
 * - `clear_flows` — empty the capture file (proxy must be stopped).
 * - `trust_ca`    — trust the mitmproxy CA in the macOS login keychain.
 *
 * Captured traffic is streamed to `<stateDir>/flows.mitm`; `flows` converts it
 * to HAR with `mitmdump --set hardump=…` so no Python addon is needed.
 *
 * @module
 */

import { z } from "npm:zod@4";

const GlobalArgsSchema = z.object({
  binDir: z.string().optional().describe(
    "Directory holding mitmdump/mitmweb. Default: ~/.local/bin if present, " +
      "else PATH",
  ),
  confdir: z.string().optional().describe(
    "mitmproxy confdir (CA certificates). Default: ~/.mitmproxy",
  ),
  stateDir: z.string().optional().describe(
    "Where the pid file, log and flow capture live. Default: " +
      "<confdir>/swamp. Use a distinct dir per model instance",
  ),
  listenHost: z.string().default("127.0.0.1").describe(
    "Proxy listen address",
  ),
  listenPort: z.number().int().min(1).max(65535).default(8080).describe(
    "Proxy listen port",
  ),
  mode: z.string().regex(/^[a-z0-9]+(:.*)?$/).default("regular").describe(
    "mitmproxy --mode: regular, socks5, upstream:URL, reverse:URL, " +
      "transparent, wireguard, local, …",
  ),
  ui: z.enum(["dump", "web"]).default("dump").describe(
    "dump runs headless mitmdump; web runs mitmweb with its browser UI",
  ),
  webHost: z.string().default("127.0.0.1").describe("mitmweb UI address"),
  webPort: z.number().int().min(1).max(65535).default(8081).describe(
    "mitmweb UI port",
  ),
  options: z.record(
    z.string().regex(/^[a-z_]+$/),
    z.union([z.string(), z.number(), z.boolean()]),
  ).default({}).describe(
    "Extra mitmproxy options passed as --set key=value " +
      "(e.g. ignore_hosts, allow_hosts, ssl_insecure, scripts)",
  ),
});

type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

interface ExecContext {
  globalArgs: GlobalArgs;
  writeResource: (
    spec: string,
    name: string,
    data: Record<string, unknown>,
  ) => Promise<unknown>;
  logger?: { info: (msg: string, meta?: Record<string, unknown>) => void };
}

/** Paths derived from the global arguments. */
export interface Paths {
  confdir: string;
  stateDir: string;
  pidFile: string;
  logFile: string;
  flowsFile: string;
  caCert: string;
}

function home(): string {
  const h = Deno.env.get("HOME");
  if (!h) throw new Error("HOME is not set");
  return h;
}

function expand(p: string): string {
  return p.startsWith("~/") ? `${home()}${p.slice(1)}` : p;
}

/** Resolve confdir/stateDir and the files inside them. */
export function resolvePaths(g: GlobalArgs): Paths {
  const confdir = expand(g.confdir ?? "~/.mitmproxy");
  const stateDir = expand(g.stateDir ?? `${confdir}/swamp`);
  return {
    confdir,
    stateDir,
    pidFile: `${stateDir}/mitmproxy.pid`,
    logFile: `${stateDir}/mitmproxy.log`,
    flowsFile: `${stateDir}/flows.mitm`,
    caCert: `${confdir}/mitmproxy-ca-cert.pem`,
  };
}

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}

/** Resolve a mitmproxy executable (mitmdump / mitmweb). */
export async function binary(g: GlobalArgs, name: string): Promise<string> {
  if (g.binDir) return `${expand(g.binDir)}/${name}`;
  const local = `${home()}/.local/bin/${name}`;
  return await exists(local) ? local : name;
}

/** Build the mitmdump/mitmweb argv for `start`. */
export function startArgs(g: GlobalArgs, paths: Paths): string[] {
  const args = [
    "--listen-host",
    g.listenHost,
    "--listen-port",
    String(g.listenPort),
    "--mode",
    g.mode,
    // "+" appends, so a restart keeps earlier flows until clear_flows.
    "--save-stream-file",
    `+${paths.flowsFile}`,
    "--set",
    `confdir=${paths.confdir}`,
  ];
  if (g.ui === "web") {
    args.push(
      "--set",
      `web_host=${g.webHost}`,
      "--set",
      `web_port=${g.webPort}`,
      "--set",
      "web_open_browser=false",
    );
  }
  for (const [k, v] of Object.entries(g.options)) {
    args.push("--set", `${k}=${v}`);
  }
  return args;
}

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function run(
  cmd: string,
  args: string[],
  env?: Record<string, string>,
): Promise<RunResult> {
  let out;
  try {
    out = await new Deno.Command(cmd, {
      args,
      env,
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
    }).output();
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) {
      return { code: 127, stdout: "", stderr: `${cmd}: not found` };
    }
    throw e;
  }
  const dec = new TextDecoder();
  return {
    code: out.code,
    stdout: dec.decode(out.stdout).trim(),
    stderr: dec.decode(out.stderr).trim(),
  };
}

async function installedVersion(g: GlobalArgs): Promise<string | null> {
  const r = await run(await binary(g, "mitmdump"), ["--version"]);
  if (r.code !== 0) return null;
  return r.stdout.match(/^Mitmproxy:\s*(\S+)/m)?.[1] ?? null;
}

async function readPid(paths: Paths): Promise<number | null> {
  try {
    const n = Number((await Deno.readTextFile(paths.pidFile)).trim());
    return Number.isInteger(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

/** True when `pid` is alive and is a mitmproxy process (guards pid reuse). */
async function isMitmProcess(pid: number): Promise<boolean> {
  const r = await run("ps", ["-p", String(pid), "-o", "command="]);
  return r.code === 0 && /mitm(dump|web|proxy)/.test(r.stdout);
}

async function listening(host: string, port: number): Promise<boolean> {
  try {
    const conn = await Deno.connect({ hostname: host, port });
    conn.close();
    return true;
  } catch {
    return false;
  }
}

async function logTail(paths: Paths, lines = 20): Promise<string[]> {
  try {
    return (await Deno.readTextFile(paths.logFile)).trimEnd().split("\n")
      .slice(-lines);
  } catch {
    return [];
  }
}

/** The tokenised mitmweb URL printed to the log, if any. */
export function webUrlFromLog(lines: string[]): string | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = lines[i].match(/(https?:\/\/\S+\?token=\S+)/);
    if (m) return m[1];
  }
  return null;
}

interface CaInfo {
  exists: boolean;
  path: string;
  sha256?: string;
  notAfter?: string;
  trusted?: boolean;
}

async function caInfo(paths: Paths): Promise<CaInfo> {
  if (!await exists(paths.caCert)) {
    return { exists: false, path: paths.caCert };
  }
  const info: CaInfo = { exists: true, path: paths.caCert };
  const x = await run("openssl", [
    "x509",
    "-in",
    paths.caCert,
    "-noout",
    "-fingerprint",
    "-sha256",
    "-enddate",
  ]);
  if (x.code === 0) {
    info.sha256 = x.stdout.match(/Fingerprint=(\S+)/)?.[1];
    info.notAfter = x.stdout.match(/notAfter=(.+)/)?.[1];
  }
  if (Deno.build.os === "darwin") {
    const v = await run("security", ["verify-cert", "-c", paths.caCert]);
    info.trusted = v.code === 0;
  }
  return info;
}

async function snapshot(g: GlobalArgs, paths: Paths) {
  const pid = await readPid(paths);
  const running = pid !== null && await isMitmProcess(pid);
  const tail = await logTail(paths);
  let flowsBytes = 0;
  try {
    flowsBytes = (await Deno.stat(paths.flowsFile)).size;
  } catch {
    // no capture yet
  }
  return {
    version: await installedVersion(g),
    running,
    pid: running ? pid : null,
    listening: await listening(g.listenHost, g.listenPort),
    proxyUrl: `http://${g.listenHost}:${g.listenPort}`,
    mode: g.mode,
    ui: g.ui,
    webUrl: running && g.ui === "web" ? webUrlFromLog(tail) : null,
    flowsFile: paths.flowsFile,
    flowsBytes,
    logFile: paths.logFile,
    logTail: tail,
    ca: await caInfo(paths),
    timestamp: new Date().toISOString(),
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** One summarised HAR entry. */
export interface FlowSummary {
  startedAt: string;
  method: string;
  url: string;
  status: number;
  mimeType: string;
  responseBytes: number;
  timeMs: number;
  requestHeaders?: Record<string, string>;
  responseHeaders?: Record<string, string>;
}

interface HarHeader {
  name: string;
  value: string;
}

interface HarEntry {
  startedDateTime?: string;
  time?: number;
  request?: { method?: string; url?: string; headers?: HarHeader[] };
  response?: {
    status?: number;
    headers?: HarHeader[];
    bodySize?: number;
    content?: { size?: number; mimeType?: string };
  };
}

function headerMap(h: HarHeader[] | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const { name, value } of h ?? []) {
    const k = name.toLowerCase();
    out[k] = k in out ? `${out[k]}, ${value}` : value;
  }
  return out;
}

/** Summarise a HAR document; keeps the newest `limit` entries. */
export function summarizeHar(
  har: unknown,
  limit: number,
  includeHeaders: boolean,
): { total: number; flows: FlowSummary[] } {
  const entries = ((har as { log?: { entries?: HarEntry[] } })?.log
    ?.entries) ?? [];
  const flows = entries.slice(-limit).map((e): FlowSummary => {
    const f: FlowSummary = {
      startedAt: e.startedDateTime ?? "",
      method: e.request?.method ?? "",
      url: e.request?.url ?? "",
      status: e.response?.status ?? 0,
      mimeType: e.response?.content?.mimeType ?? "",
      responseBytes: e.response?.content?.size ?? e.response?.bodySize ?? 0,
      timeMs: Math.round(e.time ?? 0),
    };
    if (includeHeaders) {
      f.requestHeaders = headerMap(e.request?.headers);
      f.responseHeaders = headerMap(e.response?.headers);
    }
    return f;
  });
  return { total: entries.length, flows };
}

const CaSchema = z.object({
  exists: z.boolean(),
  path: z.string(),
  sha256: z.string().optional(),
  notAfter: z.string().optional(),
  trusted: z.boolean().optional(),
});

const StatusSchema = z.object({
  version: z.string().nullable(),
  running: z.boolean(),
  pid: z.number().nullable(),
  listening: z.boolean(),
  proxyUrl: z.string(),
  mode: z.string(),
  ui: z.string(),
  webUrl: z.string().nullable(),
  flowsFile: z.string(),
  flowsBytes: z.number(),
  logFile: z.string(),
  logTail: z.array(z.string()),
  ca: CaSchema,
  timestamp: z.string(),
});

const InstallArgsSchema = z.object({
  python: z.string().regex(/^3\.\d+$/).default("3.13").describe(
    "Python version uv uses for the tool venv (must have mitmproxy wheels)",
  ),
  version: z.string().regex(/^\d+(\.\d+)*$/).optional().describe(
    "Pin a mitmproxy version; default is the latest",
  ),
  upgrade: z.boolean().default(false).describe(
    "Reinstall even when mitmproxy is already present",
  ),
});

const StartArgsSchema = z.object({
  timeoutSeconds: z.number().int().min(1).max(120).default(20).describe(
    "How long to wait for the proxy port to accept connections",
  ),
});

const StopArgsSchema = z.object({
  timeoutSeconds: z.number().int().min(1).max(60).default(10).describe(
    "Grace period after SIGTERM before SIGKILL",
  ),
});

const FlowsArgsSchema = z.object({
  filter: z.string().optional().describe(
    "mitmproxy filter expression, e.g. '~d example.com & ~m POST'",
  ),
  limit: z.number().int().min(1).max(5000).default(100).describe(
    "Keep only the newest N matching flows",
  ),
  includeHeaders: z.boolean().default(false).describe(
    "Include request/response headers in each flow",
  ),
});

/** The `@magistr/mitmproxy` model definition. */
export const model = {
  type: "@magistr/mitmproxy",
  version: "2026.10.21.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    installation: {
      description: "Installed mitmproxy version",
      schema: z.object({
        version: z.string(),
        changed: z.boolean(),
        python: z.string(),
        timestamp: z.string(),
      }),
      lifetime: "infinite",
      garbageCollection: 10,
    },
    status: {
      description: "Proxy process, listener and CA certificate state",
      schema: StatusSchema,
      lifetime: "infinite",
      garbageCollection: 50,
    },
    flows: {
      description: "Summary of captured flows",
      schema: z.object({
        filter: z.string().nullable(),
        total: z.number(),
        returned: z.number(),
        flows: z.array(z.record(z.string(), z.unknown())),
        timestamp: z.string(),
      }),
      lifetime: "infinite",
      garbageCollection: 20,
    },
  },
  methods: {
    install: {
      description: "Install mitmproxy with `uv tool install --no-build` " +
        "(prebuilt wheels only, nothing is compiled). Skips when present.",
      arguments: InstallArgsSchema,
      execute: async (
        rawArgs: Record<string, unknown>,
        context: ExecContext,
      ) => {
        const args = InstallArgsSchema.parse(rawArgs);
        const g = GlobalArgsSchema.parse(context.globalArgs);
        const before = await installedVersion(g);
        const wanted = !args.version || before === args.version;
        if (before && wanted && !args.upgrade) {
          await context.writeResource("installation", "installation", {
            version: before,
            changed: false,
            python: args.python,
            timestamp: new Date().toISOString(),
          });
          return {};
        }
        const pkg = args.version ? `mitmproxy==${args.version}` : "mitmproxy";
        const uvLocal = `${home()}/.local/bin/uv`;
        const uv = await exists(uvLocal) ? uvLocal : "uv";
        const r = await run(uv, [
          "tool",
          "install",
          "--force",
          "--python",
          args.python,
          "--no-build",
          pkg,
        ]);
        if (r.code !== 0) {
          throw new Error(
            `uv tool install failed (exit ${r.code}): ${r.stderr.slice(-2000)}`,
          );
        }
        const after = await installedVersion(g);
        if (!after) {
          throw new Error(
            "mitmproxy installed but mitmdump is not runnable; set binDir",
          );
        }
        await context.writeResource("installation", "installation", {
          version: after,
          changed: after !== before,
          python: args.python,
          timestamp: new Date().toISOString(),
        });
        context.logger?.info("mitmproxy {v} installed", { v: after });
        return {};
      },
    },
    status: {
      description: "Read installed version, process, listener and CA state.",
      arguments: z.object({}),
      execute: async (_args: Record<string, unknown>, context: ExecContext) => {
        const g = GlobalArgsSchema.parse(context.globalArgs);
        await context.writeResource(
          "status",
          "status",
          await snapshot(g, resolvePaths(g)),
        );
        return {};
      },
    },
    start: {
      description: "Start mitmdump (ui=dump) or mitmweb (ui=web) in the " +
        "background, streaming flows to <stateDir>/flows.mitm. No-op when " +
        "already running.",
      arguments: StartArgsSchema,
      execute: async (
        rawArgs: Record<string, unknown>,
        context: ExecContext,
      ) => {
        const args = StartArgsSchema.parse(rawArgs);
        const g = GlobalArgsSchema.parse(context.globalArgs);
        const paths = resolvePaths(g);
        const pid = await readPid(paths);
        if (pid !== null && await isMitmProcess(pid)) {
          await context.writeResource(
            "status",
            "status",
            await snapshot(g, paths),
          );
          return {};
        }
        if (await listening(g.listenHost, g.listenPort)) {
          throw new Error(
            `${g.listenHost}:${g.listenPort} is already in use by another ` +
              "process; stop it or change listenPort",
          );
        }
        const bin = await binary(g, g.ui === "web" ? "mitmweb" : "mitmdump");
        if (!await installedVersion(g)) {
          throw new Error("mitmproxy is not installed; run the install method");
        }
        await Deno.mkdir(paths.stateDir, { recursive: true });
        // Detach through nohup so the proxy outlives this method; the log path
        // and argv travel as env/positional args, never interpolated.
        const r = await run(
          "/bin/sh",
          [
            "-c",
            'nohup "$@" >"$MITM_LOG" 2>&1 </dev/null & echo $!',
            "sh",
            bin,
            ...startArgs(g, paths),
          ],
          { MITM_LOG: paths.logFile },
        );
        const newPid = Number(r.stdout);
        if (r.code !== 0 || !Number.isInteger(newPid) || newPid <= 0) {
          throw new Error(`failed to launch ${bin}: ${r.stderr}`);
        }
        await Deno.writeTextFile(paths.pidFile, `${newPid}\n`);
        const deadline = Date.now() + args.timeoutSeconds * 1000;
        while (!await listening(g.listenHost, g.listenPort)) {
          if (!await isMitmProcess(newPid)) {
            await Deno.remove(paths.pidFile).catch(() => {});
            throw new Error(
              `mitmproxy exited during startup:\n${
                (await logTail(paths)).join("\n")
              }`,
            );
          }
          if (Date.now() > deadline) {
            throw new Error(
              `mitmproxy (pid ${newPid}) did not listen on ` +
                `${g.listenHost}:${g.listenPort} within ` +
                `${args.timeoutSeconds}s`,
            );
          }
          await sleep(250);
        }
        if (g.ui === "web") {
          // mitmweb prints its tokenised URL shortly after binding the proxy.
          for (let i = 0; i < 20 && !webUrlFromLog(await logTail(paths)); i++) {
            await sleep(250);
          }
        }
        await context.writeResource(
          "status",
          "status",
          await snapshot(g, paths),
        );
        context.logger?.info("mitmproxy started (pid {pid})", { pid: newPid });
        return {};
      },
    },
    stop: {
      description: "Stop the background proxy started by `start`. No-op when " +
        "it is not running.",
      arguments: StopArgsSchema,
      execute: async (
        rawArgs: Record<string, unknown>,
        context: ExecContext,
      ) => {
        const args = StopArgsSchema.parse(rawArgs);
        const g = GlobalArgsSchema.parse(context.globalArgs);
        const paths = resolvePaths(g);
        const pid = await readPid(paths);
        if (pid !== null && await isMitmProcess(pid)) {
          Deno.kill(pid, "SIGTERM");
          const deadline = Date.now() + args.timeoutSeconds * 1000;
          while (await isMitmProcess(pid) && Date.now() < deadline) {
            await sleep(200);
          }
          if (await isMitmProcess(pid)) {
            Deno.kill(pid, "SIGKILL");
            await sleep(200);
          }
          context.logger?.info("mitmproxy stopped (pid {pid})", { pid });
        }
        await Deno.remove(paths.pidFile).catch(() => {});
        await context.writeResource(
          "status",
          "status",
          await snapshot(g, paths),
        );
        return {};
      },
    },
    flows: {
      description: "Summarise captured flows (method, URL, status, size, " +
        "timing), optionally narrowed by a mitmproxy filter expression.",
      arguments: FlowsArgsSchema,
      execute: async (
        rawArgs: Record<string, unknown>,
        context: ExecContext,
      ) => {
        const args = FlowsArgsSchema.parse(rawArgs);
        const g = GlobalArgsSchema.parse(context.globalArgs);
        const paths = resolvePaths(g);
        let summary: { total: number; flows: FlowSummary[] } = {
          total: 0,
          flows: [],
        };
        if (await exists(paths.flowsFile)) {
          const har = await Deno.makeTempFile({ suffix: ".har" });
          try {
            const r = await run(await binary(g, "mitmdump"), [
              "-q",
              "-n",
              "-r",
              paths.flowsFile,
              "--set",
              `hardump=${har}`,
              ...(args.filter ? [args.filter] : []),
            ]);
            if (r.code !== 0) {
              throw new Error(
                `mitmdump could not read flows (exit ${r.code}): ${
                  (r.stderr || r.stdout).slice(-2000)
                }`,
              );
            }
            summary = summarizeHar(
              JSON.parse(await Deno.readTextFile(har)),
              args.limit,
              args.includeHeaders,
            );
          } finally {
            await Deno.remove(har).catch(() => {});
          }
        }
        await context.writeResource("flows", "flows", {
          filter: args.filter ?? null,
          total: summary.total,
          returned: summary.flows.length,
          flows: summary.flows,
          timestamp: new Date().toISOString(),
        });
        return {};
      },
    },
    clear_flows: {
      description: "Delete the flow capture file. Refuses while the proxy " +
        "is running, because it holds the file open.",
      arguments: z.object({}),
      execute: async (_args: Record<string, unknown>, context: ExecContext) => {
        const g = GlobalArgsSchema.parse(context.globalArgs);
        const paths = resolvePaths(g);
        const pid = await readPid(paths);
        if (pid !== null && await isMitmProcess(pid)) {
          throw new Error(
            `mitmproxy is running (pid ${pid}); stop it before clear_flows`,
          );
        }
        await Deno.remove(paths.flowsFile).catch((e) => {
          if (!(e instanceof Deno.errors.NotFound)) throw e;
        });
        await context.writeResource(
          "status",
          "status",
          await snapshot(g, paths),
        );
        return {};
      },
    },
    trust_ca: {
      description: "Trust the mitmproxy CA certificate in the macOS login " +
        "keychain (macOS asks for your password). No-op when already trusted.",
      arguments: z.object({}),
      execute: async (_args: Record<string, unknown>, context: ExecContext) => {
        const g = GlobalArgsSchema.parse(context.globalArgs);
        const paths = resolvePaths(g);
        if (Deno.build.os !== "darwin") {
          throw new Error(
            `trust_ca supports macOS only; on ${Deno.build.os} install ` +
              `${paths.caCert} into the system trust store manually`,
          );
        }
        const ca = await caInfo(paths);
        if (!ca.exists) {
          throw new Error(
            `${paths.caCert} does not exist; run start once to generate it`,
          );
        }
        if (!ca.trusted) {
          const r = await run("security", [
            "add-trusted-cert",
            "-r",
            "trustRoot",
            "-k",
            `${home()}/Library/Keychains/login.keychain-db`,
            paths.caCert,
          ]);
          if (r.code !== 0) {
            throw new Error(
              `security add-trusted-cert failed (exit ${r.code}): ${r.stderr}`,
            );
          }
        }
        await context.writeResource(
          "status",
          "status",
          await snapshot(g, paths),
        );
        return {};
      },
    },
  },
};
