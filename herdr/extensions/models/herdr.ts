// @magistr/herdr — drive a herdr terminal-agent runtime from swamp.
//
// herdr (https://herdr.dev) is a terminal multiplexer built for AI coding
// agents: a background server owns persistent workspaces → tabs → panes,
// recognises the agent running inside each pane, and exposes the whole tree
// over a local Unix socket. Its CLI is a thin wrapper over that socket and
// answers in JSON envelopes.
//
// This model turns the fleet into swamp data and swamp methods:
//
//   observe   status, snapshot, read
//   drive     prompt, wait-agent, start-agent, send-keys, send-text,
//             run-command, wait-output
//   shape     create-workspace, create-tab, split-pane, create-worktree,
//             close, notify
//
// Two properties are worth calling out, because they are what make this
// safe to run from inside the very fleet it manages:
//
//   * Every mutating method reads herdr's state first. `close` on a missing
//     id is a recorded no-op instead of an error; `create-workspace` /
//     `create-tab` / `create-worktree` reuse an existing container with the
//     same label/branch; `start-agent` leaves a pane that already hosts an
//     agent alone. Re-running a method is safe.
//   * swamp itself usually runs INSIDE a herdr pane, so herdr's own
//     `HERDR_PANE_ID` / `HERDR_TAB_ID` / `HERDR_WORKSPACE_ID` environment is
//     used to refuse to close the terminal issuing the command, and to skip
//     the caller when a prompt fans out across the fleet.
//
// Fan-out methods take a `targets` array and run in one method execution —
// one model lock, one action resource — rather than N calls contending on
// the same lock.

import { z } from "npm:zod@4";
import {
  assertEnvPairs,
  assertTarget,
  boundText,
  type CommandRunner,
  defaultEnvGet,
  defaultRunner,
  type EnvGetter,
  type HerdrConfig,
  HerdrError,
  herdrJson,
  herdrOk,
  herdrText,
  parseStatusBlocks,
  pushFlag,
  pushFocus,
  pushRepeated,
  type SelfLocation,
  selfLocationFor,
  targetLabel,
  yesNo,
} from "./lib/cli.ts";

// --- Global arguments --------------------------------------------------------

const GlobalArgsSchema = z.object({
  binary: z
    .string()
    .default("herdr")
    .describe("herdr executable — a bare name is resolved on PATH"),
  session: z
    .string()
    .default("")
    .describe(
      "Named herdr session (HERDR_SESSION); empty targets the default session",
    ),
  socketPath: z
    .string()
    .default("")
    .describe(
      "Override the server socket (HERDR_SOCKET_PATH); empty uses herdr's own default",
    ),
  timeoutMs: z
    .number()
    .int()
    .min(1000)
    .max(3_600_000)
    .default(30_000)
    .describe("Wall-clock cap for a single herdr invocation"),
  maxOutputBytes: z
    .number()
    .int()
    .min(1024)
    .max(8_388_608)
    .default(262_144)
    .describe("Cap on captured terminal text per read, in bytes"),
  sshHost: z
    .string()
    .default("")
    .describe(
      "Drive a herdr server on this host over ssh; empty uses the local server",
    ),
  sshUser: z
    .string()
    .default("")
    .describe("ssh user; empty lets ssh resolve it from ~/.ssh/config"),
  sshPort: z
    .number()
    .int()
    .min(0)
    .max(65_535)
    .default(0)
    .describe("ssh port; 0 uses ssh's own default"),
  sshIdentityFile: z
    .string()
    .default("")
    .describe("Private key passed to ssh -i; empty uses the agent/ssh config"),
  sshExtraArgs: z
    .array(z.string())
    .default([])
    .describe(
      "Extra ssh arguments, placed before the defaults so they take precedence",
    ),
  remoteBinary: z
    .string()
    .default("")
    .describe("herdr executable on the remote host; empty reuses binary"),
});

type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

/**
 * The subset of swamp's method context this model uses. Declared structurally
 * so tests can pass a double; swamp owns the real object and it must never be
 * mutated to carry injected dependencies.
 */
export interface HerdrContext {
  globalArgs: Record<string, unknown>;
  writeResource(
    specName: string,
    instanceName: string,
    data: unknown,
  ): Promise<unknown>;
}

/** Build the CLI transport config from a method context's global arguments. */
export function cfgFrom(context: HerdrContext): HerdrConfig {
  const g = GlobalArgsSchema.parse(context.globalArgs ?? {}) as GlobalArgs;
  return {
    binary: g.binary,
    session: g.session,
    socketPath: g.socketPath,
    timeoutMs: g.timeoutMs,
    // sshHost is the single switch between the two transports: everything
    // else is inert until a host is named.
    ssh: g.sshHost
      ? {
        host: g.sshHost,
        user: g.sshUser,
        port: g.sshPort,
        identityFile: g.sshIdentityFile,
        binary: g.remoteBinary,
        extraArgs: g.sshExtraArgs,
      }
      : null,
  };
}

/** Read `maxOutputBytes` from a context, falling back to the schema default. */
function maxOutputBytes(context: HerdrContext): number {
  return (GlobalArgsSchema.parse(context.globalArgs ?? {}) as GlobalArgs)
    .maxOutputBytes;
}

/**
 * herdr ids look like `w1:p4`; swamp data instance names become paths on
 * disk, so anything outside `[A-Za-z0-9._-]` is folded to a dash.
 */
export function sanitizeInstance(value: string): string {
  const cleaned = value
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");
  return (cleaned || "unnamed").slice(0, 80);
}

// --- herdr → swamp mapping ---------------------------------------------------

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function bool(value: unknown): boolean {
  return value === true;
}

function obj(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function arr(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.map(obj) : [];
}

/**
 * Flatten herdr's `AgentInfo` into a swamp resource.
 *
 * `agent_session` is the join key back to the agent's own transcript store —
 * for Claude Code it carries the session UUID, which is what makes an agent
 * row correlatable with `@magistr/claude-sessions` data.
 */
export function toAgent(
  info: Record<string, unknown>,
  observedAt: string,
): Record<string, unknown> {
  const session = obj(info.agent_session);
  const sessionKind = str(session.kind);
  const sessionValue = str(session.value);
  return {
    kind: "agent",
    paneId: str(info.pane_id),
    tabId: str(info.tab_id),
    workspaceId: str(info.workspace_id),
    agent: str(info.agent),
    name: str(info.name) || str(info.display_agent),
    status: str(info.agent_status) || "unknown",
    cwd: str(info.cwd),
    foregroundCwd: str(info.foreground_cwd),
    terminalId: str(info.terminal_id),
    terminalTitle: str(info.terminal_title_stripped) ||
      str(info.terminal_title),
    sessionId: sessionKind === "id" ? sessionValue : "",
    sessionPath: sessionKind === "path" ? sessionValue : "",
    focused: bool(info.focused),
    revision: num(info.revision),
    stateChangeSeq: num(info.state_change_seq),
    observedAt,
  };
}

function toWorkspaceRow(info: Record<string, unknown>) {
  return {
    workspaceId: str(info.workspace_id),
    label: str(info.label),
    number: num(info.number),
    focused: bool(info.focused),
    activeTabId: str(info.active_tab_id),
    tabCount: num(info.tab_count),
    paneCount: num(info.pane_count),
    agentStatus: str(info.agent_status) || "unknown",
    worktreePath: str(obj(info.worktree).checkout_path),
  };
}

function toTabRow(info: Record<string, unknown>) {
  return {
    tabId: str(info.tab_id),
    workspaceId: str(info.workspace_id),
    label: str(info.label),
    number: num(info.number),
    focused: bool(info.focused),
    paneCount: num(info.pane_count),
    agentStatus: str(info.agent_status) || "unknown",
  };
}

// --- Resource schemas --------------------------------------------------------

const AgentSchema = z.object({
  kind: z.literal("agent"),
  paneId: z.string(),
  tabId: z.string(),
  workspaceId: z.string(),
  agent: z.string(),
  name: z.string(),
  status: z.string(),
  cwd: z.string(),
  foregroundCwd: z.string(),
  terminalId: z.string(),
  terminalTitle: z.string(),
  sessionId: z.string(),
  sessionPath: z.string(),
  focused: z.boolean(),
  revision: z.number(),
  stateChangeSeq: z.number(),
  observedAt: z.string(),
});

const FleetSchema = z.object({
  kind: z.literal("fleet"),
  observedAt: z.string(),
  version: z.string(),
  protocol: z.number(),
  focusedWorkspaceId: z.string(),
  focusedTabId: z.string(),
  focusedPaneId: z.string(),
  workspaceCount: z.number(),
  tabCount: z.number(),
  paneCount: z.number(),
  agentCount: z.number(),
  busyCount: z.number(),
  idleCount: z.number(),
  blockedCount: z.number(),
  byStatus: z.record(z.string(), z.number()),
  workspaces: z.array(
    z.object({
      workspaceId: z.string(),
      label: z.string(),
      number: z.number(),
      focused: z.boolean(),
      activeTabId: z.string(),
      tabCount: z.number(),
      paneCount: z.number(),
      agentStatus: z.string(),
      worktreePath: z.string(),
    }),
  ),
  tabs: z.array(
    z.object({
      tabId: z.string(),
      workspaceId: z.string(),
      label: z.string(),
      number: z.number(),
      focused: z.boolean(),
      paneCount: z.number(),
      agentStatus: z.string(),
    }),
  ),
  agents: z.array(AgentSchema),
});

const StatusSchema = z.object({
  kind: z.literal("status"),
  checkedAt: z.string(),
  target: z.string(),
  remote: z.boolean(),
  configOk: z.boolean(),
  configDetail: z.string(),
  clientVersion: z.string(),
  clientChannel: z.string(),
  clientProtocol: z.number(),
  serverRunning: z.boolean(),
  serverStatus: z.string(),
  serverVersion: z.string(),
  serverProtocol: z.number(),
  compatible: z.boolean(),
  socket: z.string(),
  restartNeeded: z.boolean(),
  sessions: z.array(
    z.object({
      name: z.string(),
      running: z.boolean(),
      isDefault: z.boolean(),
      socketPath: z.string(),
      sessionDir: z.string(),
    }),
  ),
  notes: z.array(z.string()),
  raw: z.string(),
});

const OutputSchema = z.object({
  kind: z.literal("output"),
  target: z.string(),
  via: z.string(),
  source: z.string(),
  format: z.string(),
  lines: z.number(),
  paneId: z.string(),
  tabId: z.string(),
  workspaceId: z.string(),
  agent: z.string(),
  agentStatus: z.string(),
  text: z.string(),
  bytes: z.number(),
  truncated: z.boolean(),
  readAt: z.string(),
});

const ActionSchema = z.object({
  kind: z.literal("action"),
  method: z.string(),
  ranAt: z.string(),
  changed: z.boolean(),
  targetCount: z.number(),
  okCount: z.number(),
  changedCount: z.number(),
  skippedCount: z.number(),
  failedCount: z.number(),
  results: z.array(
    z.object({
      target: z.string(),
      paneId: z.string(),
      ok: z.boolean(),
      changed: z.boolean(),
      status: z.string(),
      detail: z.string(),
    }),
  ),
});

const ManifestsSchema = z.object({
  kind: z.literal("manifests"),
  checkedAt: z.string(),
  target: z.string(),
  lastCheckUnix: z.number(),
  lastResult: z.string(),
  total: z.number(),
  bundledCount: z.number(),
  remoteCount: z.number(),
  warningCount: z.number(),
  changedAgents: z.array(z.string()),
  manifests: z.array(
    z.object({
      agent: z.string(),
      activeVersion: z.string(),
      cachedRemoteVersion: z.string(),
      sourceKind: z.string(),
      source: z.string(),
      remoteUpdateResult: z.string(),
      remoteLastCheckedUnix: z.number(),
      localOverrideShadowingRemote: z.boolean(),
      warning: z.string(),
    }),
  ),
});

const ContainerSchema = z.object({
  kind: z.literal("container"),
  container: z.string(),
  created: z.boolean(),
  reason: z.string(),
  workspaceId: z.string(),
  tabId: z.string(),
  paneId: z.string(),
  label: z.string(),
  number: z.number(),
  path: z.string(),
  branch: z.string(),
  cwd: z.string(),
  ranAt: z.string(),
});

// --- Fan-out plumbing --------------------------------------------------------

/** One target's outcome inside a fan-out method. */
export interface TargetOutcome {
  target: string;
  paneId: string;
  ok: boolean;
  changed: boolean;
  status: string;
  detail: string;
}

function errText(err: unknown): string {
  if (err instanceof HerdrError) return `${err.code}: ${err.message}`;
  return err instanceof Error ? err.message : String(err);
}

/** Drop repeats while preserving order — a target listed twice is acted on once. */
export function dedupeTargets(targets: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of targets) {
    const target = raw.trim();
    if (!target || seen.has(target)) continue;
    seen.add(target);
    out.push(target);
  }
  return out;
}

/**
 * Run `handler` for every target, isolating per-target failures.
 *
 * With `failFast` the first failure aborts the run (and the whole method
 * throws); otherwise a failing target becomes a `ok: false` row and the rest
 * still run — the same error-isolation contract as a factory method.
 */
export async function fanOut(
  targets: readonly string[],
  failFast: boolean,
  handler: (target: string) => Promise<Omit<TargetOutcome, "target">>,
): Promise<TargetOutcome[]> {
  const outcomes: TargetOutcome[] = [];
  for (const target of targets) {
    try {
      outcomes.push({ target, ...(await handler(target)) });
    } catch (err) {
      if (failFast) throw err;
      outcomes.push({
        target,
        paneId: "",
        ok: false,
        changed: false,
        status: "",
        detail: errText(err),
      });
    }
  }
  return outcomes;
}

/**
 * Persist a fan-out's outcomes as an `action` resource.
 *
 * Throws WITHOUT writing when every target failed: a run where nothing
 * succeeded is a failed method, and persisting it would leave misleading
 * data behind for the next CEL expression to read.
 */
async function writeAction(
  context: HerdrContext,
  method: string,
  outcomes: TargetOutcome[],
  ranAt: string,
): Promise<unknown> {
  const okCount = outcomes.filter((o) => o.ok).length;
  const changedCount = outcomes.filter((o) => o.changed).length;
  const failed = outcomes.filter((o) => !o.ok);
  if (outcomes.length > 0 && okCount === 0) {
    throw new HerdrError(
      `${method} failed for all ${outcomes.length} target(s): ${
        failed.map((o) => `${o.target} (${o.detail})`).join("; ")
      }`,
      { code: "all_targets_failed" },
    );
  }
  return await context.writeResource("action", `action-${method}`, {
    kind: "action",
    method,
    ranAt,
    changed: changedCount > 0,
    targetCount: outcomes.length,
    okCount,
    changedCount,
    skippedCount: outcomes.filter((o) => o.ok && !o.changed).length,
    failedCount: failed.length,
    results: outcomes.map((o) => ({
      target: o.target,
      paneId: o.paneId,
      ok: o.ok,
      changed: o.changed,
      status: o.status,
      detail: o.detail,
    })),
  });
}

/** One row of `herdr server agent-manifests --json`, flattened. */
export function toManifestRow(info: Record<string, unknown>) {
  return {
    agent: str(info.agent),
    activeVersion: str(info.active_version),
    cachedRemoteVersion: str(info.cached_remote_version),
    sourceKind: str(info.source_kind),
    source: str(info.source),
    remoteUpdateResult: str(info.remote_update_result),
    remoteLastCheckedUnix: num(info.remote_last_checked_unix),
    localOverrideShadowingRemote: bool(info.local_override_shadowing_remote),
    warning: str(info.warning),
  };
}

/** Build the manifests resource payload from an agent_manifest_status result. */
function toManifests(
  result: Record<string, unknown>,
  cfg: HerdrConfig,
  checkedAt: string,
  changedAgents: string[],
): Record<string, unknown> {
  const manifests = arr(result.manifests).map(toManifestRow);
  return {
    kind: "manifests",
    checkedAt,
    target: targetLabel(cfg),
    lastCheckUnix: num(result.last_check_unix),
    lastResult: str(result.last_result),
    total: manifests.length,
    bundledCount: manifests.filter((m) => m.sourceKind === "bundled").length,
    remoteCount: manifests.filter((m) => m.sourceKind === "remote").length,
    warningCount: manifests.filter((m) => m.warning !== "").length,
    changedAgents,
    manifests,
  };
}

/** Read the named-session inventory (`session list --json` is not enveloped). */
async function readSessions(
  run: CommandRunner,
  cfg: HerdrConfig,
): Promise<Record<string, unknown>[]> {
  const listed = await herdrText(run, cfg, ["session", "list", "--json"]);
  return arr(obj(JSON.parse(listed.trim() || "{}")).sessions);
}

/** Is a server actually up? `herdr status` answers even when it is not. */
async function readServerRunning(
  run: CommandRunner,
  cfg: HerdrConfig,
): Promise<{ running: boolean; status: string }> {
  const blocks = parseStatusBlocks(await herdrText(run, cfg, ["status"]));
  const status = blocks.server?.status ?? "";
  return { running: status === "running", status };
}

/** Index the live agents by pane id and by name, for target resolution. */
async function loadAgents(
  run: CommandRunner,
  cfg: HerdrConfig,
): Promise<Map<string, Record<string, unknown>>> {
  const result = await herdrJson(run, cfg, ["agent", "list"]);
  const index = new Map<string, Record<string, unknown>>();
  for (const info of arr(result.agents)) {
    const paneId = str(info.pane_id);
    if (paneId) index.set(paneId, info);
    const name = str(info.name);
    if (name) index.set(name, info);
  }
  return index;
}

// --- Argument schemas --------------------------------------------------------

const ReadSource = z.enum([
  "visible",
  "recent",
  "recent-unwrapped",
  "detection",
]);
const AgentState = z.enum(["idle", "working", "blocked", "done", "unknown"]);

const StatusArgs = z.object({});

const SnapshotArgs = z.object({
  workspace: z
    .string()
    .default("")
    .describe(
      "Restrict to one workspace by id (w1) or exact label; empty = all",
    ),
  status: z
    .array(AgentState)
    .default([])
    .describe("Keep only agents in these states; empty keeps every agent"),
  writeAgents: z
    .boolean()
    .default(true)
    .describe(
      "Also write one agent resource per agent, not just the fleet roll-up",
    ),
});

const ReadArgs = z.object({
  target: z.string().min(1).describe("Pane id (w1:p4) or agent name"),
  via: z
    .enum(["pane", "agent"])
    .default("pane")
    .describe("Resolve the target as a pane or as a named agent"),
  source: ReadSource
    .default("visible")
    .describe(
      "visible = current screen, recent = scrollback tail, detection = what herdr's agent classifier saw (agent only)",
    ),
  lines: z
    .number()
    .int()
    .min(0)
    .max(10_000)
    .default(0)
    .describe("Cap the captured lines (0 = herdr's own default)"),
  format: z
    .enum(["text", "ansi"])
    .default("text")
    .describe("ansi preserves escape sequences (colour, cursor moves)"),
});

const PromptArgs = z.object({
  targets: z
    .array(z.string())
    .min(1)
    .describe("Pane ids or agent names to prompt"),
  text: z.string().min(1).describe("Prompt to submit to each agent"),
  wait: z
    .boolean()
    .default(false)
    .describe(
      "Block until each agent settles instead of returning immediately",
    ),
  until: z
    .array(AgentState)
    .default([])
    .describe("Agent states that end the wait (implies wait)"),
  timeoutMs: z
    .number()
    .int()
    .min(0)
    .max(3_600_000)
    .default(0)
    .describe("Per-target wait timeout (0 = herdr's default)"),
  includeSelf: z
    .boolean()
    .default(false)
    .describe(
      "Allow prompting the pane running this method — normally skipped, since an agent prompting itself deadlocks its own wait",
    ),
  failFast: z
    .boolean()
    .default(false)
    .describe("Abort on the first failing target instead of isolating it"),
});

const WaitAgentArgs = z.object({
  targets: z.array(z.string()).min(1).describe("Pane ids or agent names"),
  until: z
    .array(AgentState)
    .default(["idle"])
    .describe("States that end the wait"),
  timeoutMs: z
    .number()
    .int()
    .min(0)
    .max(3_600_000)
    .default(0)
    .describe("Per-target timeout (0 = herdr's default)"),
  failFast: z.boolean().default(false).describe("Abort on the first failure"),
});

const StartAgentArgs = z.object({
  pane: z.string().min(1).describe("Pane to start the agent in (w1:p4)"),
  kind: z
    .string()
    .min(1)
    .describe(
      "Agent kind herdr knows how to launch and classify — claude, codex, pi, gemini, cursor, opencode, …",
    ),
  name: z
    .string()
    .min(1)
    .describe("Name for the agent; how later methods address it"),
  agentArgs: z
    .array(z.string())
    .default([])
    .describe("Extra argv passed through to the agent binary after --"),
  timeoutMs: z
    .number()
    .int()
    .min(0)
    .max(3_600_000)
    .default(0)
    .describe("How long herdr waits for the agent to come up (0 = default)"),
  force: z
    .boolean()
    .default(false)
    .describe("Start even when the pane already hosts an agent"),
});

const SendKeysArgs = z.object({
  targets: z.array(z.string()).min(1).describe("Pane ids or agent names"),
  keys: z
    .array(z.string().min(1))
    .min(1)
    .describe("Key names: enter, esc, tab, ctrl+c, alt+x, shift+tab, f1, …"),
  via: z
    .enum(["pane", "agent"])
    .default("pane")
    .describe("Address the targets as panes or as named agents"),
  failFast: z.boolean().default(false).describe("Abort on the first failure"),
});

const SendTextArgs = z.object({
  targets: z.array(z.string()).min(1).describe("Pane ids"),
  text: z
    .string()
    .min(1)
    .describe("Literal text typed into the pane — no Enter is sent"),
  failFast: z.boolean().default(false).describe("Abort on the first failure"),
});

const RunCommandArgs = z.object({
  targets: z.array(z.string()).min(1).describe("Pane ids"),
  command: z
    .string()
    .min(1)
    .describe("Shell command typed into the pane and submitted with Enter"),
  failFast: z.boolean().default(false).describe("Abort on the first failure"),
});

const WaitOutputArgs = z.object({
  pane: z.string().min(1).describe("Pane id to watch"),
  match: z.string().default("").describe("Literal substring to wait for"),
  regex: z.string().default("").describe(
    "Regex to wait for (instead of match)",
  ),
  source: z
    .enum(["visible", "recent", "recent-unwrapped"])
    .default("recent")
    .describe("Which capture the pattern is matched against"),
  lines: z
    .number()
    .int()
    .min(0)
    .max(10_000)
    .default(0)
    .describe("Lines searched (0 = herdr's default)"),
  timeoutMs: z
    .number()
    .int()
    .min(0)
    .max(3_600_000)
    .default(0)
    .describe("Give up after this long (0 = herdr's default)"),
  raw: z
    .boolean()
    .default(false)
    .describe("Match against raw output including ANSI escapes"),
});

const CreateWorkspaceArgs = z.object({
  label: z.string().min(1).describe("Workspace label — also the reuse key"),
  cwd: z.string().default("").describe("Working directory for the first pane"),
  env: z
    .array(z.string())
    .default([])
    .describe("KEY=VALUE pairs exported into the workspace's panes"),
  focus: z.boolean().default(false).describe("Focus the workspace afterwards"),
  reuse: z
    .boolean()
    .default(true)
    .describe(
      "Return the existing workspace with this label instead of a duplicate",
    ),
});

const CreateTabArgs = z.object({
  workspace: z
    .string()
    .default("")
    .describe("Workspace id; empty uses herdr's focused workspace"),
  label: z.string().min(1).describe("Tab label — also the reuse key"),
  cwd: z.string().default("").describe("Working directory for the tab's pane"),
  env: z.array(z.string()).default([]).describe("KEY=VALUE pairs for the pane"),
  focus: z.boolean().default(false).describe("Focus the tab afterwards"),
  reuse: z
    .boolean()
    .default(true)
    .describe("Return the existing tab with this label instead of a duplicate"),
});

const SplitPaneArgs = z.object({
  pane: z.string().min(1).describe("Pane to split"),
  direction: z
    .enum(["right", "down"])
    .default("right")
    .describe("Where the new pane goes"),
  ratio: z
    .number()
    .min(0)
    .max(0.95)
    .default(0)
    .describe(
      "Fraction of the original pane given to the new one; 0 splits evenly",
    ),
  cwd: z.string().default("").describe("Working directory for the new pane"),
  env: z.array(z.string()).default([]).describe("KEY=VALUE pairs for the pane"),
  focus: z.boolean().default(false).describe("Focus the new pane"),
});

const CreateWorktreeArgs = z.object({
  cwd: z
    .string()
    .min(1)
    .describe("Path inside the Git repository the worktree is cut from"),
  branch: z.string().default("").describe(
    "Branch to check out — the reuse key",
  ),
  base: z.string().default("").describe("Base ref for a new branch"),
  path: z
    .string()
    .default("")
    .describe("Checkout path; empty lets herdr choose one"),
  label: z.string().default("").describe("Label for the worktree's workspace"),
  focus: z.boolean().default(false).describe("Focus the new workspace"),
  reuse: z
    .boolean()
    .default(true)
    .describe(
      "Open an existing worktree for this branch instead of creating one",
    ),
});

const CloseArgs = z.object({
  container: z
    .enum(["workspace", "tab", "pane"])
    .describe("What to close"),
  id: z.string().min(1).describe("Container id: w1, w1:t3 or w1:p4"),
  missingOk: z
    .boolean()
    .default(true)
    .describe("Treat an already-gone container as a successful no-op"),
  force: z
    .boolean()
    .default(false)
    .describe(
      "Close even when the target is the pane/tab/workspace running this method",
    ),
});

const ServerStopArgs = z.object({
  missingOk: z
    .boolean()
    .default(true)
    .describe("Treat an already-stopped server as a successful no-op"),
  force: z
    .boolean()
    .default(false)
    .describe(
      "Stop even when this method is running inside a pane of that very server",
    ),
});

const ServerReloadConfigArgs = z.object({
  force: z
    .boolean()
    .default(false)
    .describe("Reload even when config.toml fails validation"),
});

const ServerLiveHandoffArgs = z.object({});

const AgentManifestsArgs = z.object({});

const SessionStopArgs = z.object({
  name: z.string().min(1).describe("Named session, or 'default'"),
  missingOk: z
    .boolean()
    .default(true)
    .describe("Treat an unknown or already-stopped session as a no-op"),
  force: z
    .boolean()
    .default(false)
    .describe("Stop even when it is the session this method is running in"),
});

const SessionDeleteArgs = z.object({
  name: z.string().min(1).describe("Named session to delete"),
  missingOk: z
    .boolean()
    .default(true)
    .describe("Treat an unknown session as a successful no-op"),
  force: z
    .boolean()
    .default(false)
    .describe(
      "Delete even when the session is still running or is the one in use",
    ),
});

const NotifyArgs = z.object({
  title: z.string().min(1).describe("Notification title"),
  body: z.string().default("").describe("Notification body"),
  position: z
    .enum(["top-left", "top-right", "bottom-left", "bottom-right"])
    .default("top-right")
    .describe("Where herdr draws the toast"),
  sound: z
    .enum(["none", "done", "request"])
    .default("none")
    .describe("Sound to play alongside the toast"),
});

// --- Method implementations --------------------------------------------------

/** `status` — client/server health plus the named-session inventory. */
export async function runStatus(
  run: CommandRunner,
  _args: z.infer<typeof StatusArgs>,
  context: HerdrContext,
): Promise<unknown[]> {
  const cfg = cfgFrom(context);
  const checkedAt = new Date().toISOString();
  const raw = await herdrText(run, cfg, ["status"]);
  const blocks = parseStatusBlocks(raw);
  const client = blocks.client ?? {};
  const server = blocks.server ?? {};
  const update = blocks.update ?? {};

  const notes: string[] = [];
  let sessions: z.infer<typeof StatusSchema>["sessions"] = [];
  try {
    const listed = await herdrText(run, cfg, ["session", "list", "--json"]);
    const parsed = JSON.parse(listed.trim() || "{}");
    sessions = arr(obj(parsed).sessions).map((s) => ({
      name: str(s.name),
      running: bool(s.running),
      isDefault: bool(s.default),
      socketPath: str(s.socket_path),
      sessionDir: str(s.session_dir),
    }));
  } catch (err) {
    // Health reporting must not fail because the session inventory did —
    // the degradation is recorded instead of swallowed.
    notes.push(`session list unavailable: ${errText(err)}`);
  }

  // `config check` validates config.toml without touching the server. It is
  // the same gate server-reload-config refuses to proceed without, surfaced
  // here so a broken config is visible before anyone tries to reload it.
  let configOk = false;
  let configDetail = "";
  try {
    configDetail = (await herdrText(run, cfg, ["config", "check"])).trim();
    configOk = true;
  } catch (err) {
    configDetail = errText(err);
    notes.push(`config check failed: ${configDetail}`);
  }

  const serverStatus = server.status ?? "";
  const handle = await context.writeResource("status", "status", {
    kind: "status",
    checkedAt,
    target: targetLabel(cfg),
    remote: cfg.ssh !== null,
    configOk,
    configDetail,
    clientVersion: client.version ?? "",
    clientChannel: client.channel ?? "",
    clientProtocol: Number(client.protocol ?? 0) || 0,
    serverRunning: serverStatus === "running",
    serverStatus,
    serverVersion: server.version ?? "",
    serverProtocol: Number(server.protocol ?? 0) || 0,
    compatible: yesNo(server.compatible),
    socket: server.socket ?? "",
    restartNeeded: yesNo(update.restart_needed),
    sessions,
    notes,
    raw: raw.trim(),
  });
  return [handle];
}

/** `snapshot` — the whole fleet in one socket round-trip. */
export async function runSnapshot(
  run: CommandRunner,
  args: z.infer<typeof SnapshotArgs>,
  context: HerdrContext,
): Promise<unknown[]> {
  const cfg = cfgFrom(context);
  const observedAt = new Date().toISOString();
  const result = await herdrJson(run, cfg, ["api", "snapshot"]);
  const snap = obj(result.snapshot);

  const wantedWorkspace = args.workspace.trim();
  let workspaces = arr(snap.workspaces).map(toWorkspaceRow);
  if (wantedWorkspace) {
    const match = workspaces.filter(
      (w) => w.workspaceId === wantedWorkspace || w.label === wantedWorkspace,
    );
    if (match.length === 0) {
      throw new HerdrError(
        `No workspace matches ${JSON.stringify(wantedWorkspace)} — have: ${
          workspaces.map((w) => `${w.workspaceId} (${w.label})`).join(", ") ||
          "none"
        }`,
        { code: "workspace_not_found" },
      );
    }
    workspaces = match;
  }
  const keepWorkspace = new Set(workspaces.map((w) => w.workspaceId));

  const tabs = arr(snap.tabs)
    .map(toTabRow)
    .filter((t) => keepWorkspace.has(t.workspaceId));

  const wanted = new Set(args.status);
  const agents = arr(snap.agents)
    .map((a) => toAgent(a, observedAt))
    .filter((a) => keepWorkspace.has(str(a.workspaceId)))
    .filter((a) => wanted.size === 0 || wanted.has(str(a.status) as never));

  const byStatus: Record<string, number> = {};
  for (const agent of agents) {
    const status = str(agent.status) || "unknown";
    byStatus[status] = (byStatus[status] ?? 0) + 1;
  }

  const paneCount =
    arr(snap.panes).filter((p) => keepWorkspace.has(str(p.workspace_id)))
      .length;

  const handles: unknown[] = [];
  if (args.writeAgents) {
    for (const agent of agents) {
      handles.push(
        await context.writeResource(
          "agent",
          `agent-${sanitizeInstance(str(agent.paneId))}`,
          agent,
        ),
      );
    }
  }

  handles.push(
    await context.writeResource("fleet", "fleet", {
      kind: "fleet",
      observedAt,
      version: str(snap.version),
      protocol: num(snap.protocol),
      focusedWorkspaceId: str(snap.focused_workspace_id),
      focusedTabId: str(snap.focused_tab_id),
      focusedPaneId: str(snap.focused_pane_id),
      workspaceCount: workspaces.length,
      tabCount: tabs.length,
      paneCount,
      agentCount: agents.length,
      busyCount: byStatus.working ?? 0,
      idleCount: byStatus.idle ?? 0,
      blockedCount: byStatus.blocked ?? 0,
      byStatus,
      workspaces,
      tabs,
      agents,
    }),
  );
  return handles;
}

/** `read` — capture a pane's or agent's terminal output. */
export async function runRead(
  run: CommandRunner,
  args: z.infer<typeof ReadArgs>,
  context: HerdrContext,
): Promise<unknown[]> {
  const cfg = cfgFrom(context);
  const target = assertTarget(args.target);
  if (args.via === "pane" && args.source === "detection") {
    throw new HerdrError(
      'source "detection" is only available with via=agent — it is the agent classifier\'s own capture',
      { code: "invalid_argument" },
    );
  }

  // Resolve the target first so the captured text lands with its pane/tab/
  // workspace ids attached and is joinable with fleet data.
  const infoArgv = args.via === "agent"
    ? ["agent", "get", target]
    : ["pane", "get", target];
  const info = await herdrJson(run, cfg, infoArgv);
  const entity = obj(args.via === "agent" ? info.agent : info.pane);

  const argv = [args.via, "read", target, "--source", args.source];
  if (args.lines > 0) argv.push("--lines", String(args.lines));
  argv.push("--format", args.format);
  const raw = await herdrText(run, cfg, argv);
  const bounded = boundText(raw, maxOutputBytes(context));

  const handle = await context.writeResource(
    "output",
    `output-${sanitizeInstance(target)}`,
    {
      kind: "output",
      target,
      via: args.via,
      source: args.source,
      format: args.format,
      lines: args.lines,
      paneId: str(entity.pane_id),
      tabId: str(entity.tab_id),
      workspaceId: str(entity.workspace_id),
      agent: str(entity.agent),
      agentStatus: str(entity.agent_status) || "unknown",
      text: bounded.text,
      bytes: bounded.bytes,
      truncated: bounded.truncated,
      readAt: new Date().toISOString(),
    },
  );
  return [handle];
}

/** `prompt` — submit a prompt to one or many agents. */
export async function runPrompt(
  run: CommandRunner,
  args: z.infer<typeof PromptArgs>,
  context: HerdrContext,
  envGet: EnvGetter = defaultEnvGet,
): Promise<unknown[]> {
  const cfg = cfgFrom(context);
  const ranAt = new Date().toISOString();
  const self = selfLocationFor(cfg, envGet);
  const agents = await loadAgents(run, cfg);
  const targets = dedupeTargets(args.targets);

  const outcomes = await fanOut(targets, args.failFast, async (target) => {
    assertTarget(target);
    const info = agents.get(target);
    const paneId = str(info?.pane_id) || (agents.has(target) ? "" : target);
    if (!args.includeSelf && self.paneId && paneId === self.paneId) {
      return {
        paneId,
        ok: true,
        changed: false,
        status: str(info?.agent_status),
        detail:
          "skipped: this is the pane running the method (set includeSelf to override)",
      };
    }
    const argv = ["agent", "prompt", target, args.text];
    if (args.wait || args.until.length > 0) argv.push("--wait");
    pushRepeated(argv, "--until", args.until);
    if (args.timeoutMs > 0) argv.push("--timeout", String(args.timeoutMs));
    const result = await herdrJson(run, cfg, argv, {
      // A waiting prompt legitimately outlives the default invocation cap.
      timeoutMs: args.timeoutMs > 0
        ? args.timeoutMs + 5_000
        : Math.max(cfg.timeoutMs, args.wait ? 600_000 : cfg.timeoutMs),
    });
    const after = obj(result.agent);
    return {
      paneId: str(after.pane_id) || paneId,
      ok: true,
      changed: true,
      status: str(after.agent_status),
      detail: "prompted",
    };
  });

  return [await writeAction(context, "prompt", outcomes, ranAt)];
}

/** `wait-agent` — block until agents reach one of the given states. */
export async function runWaitAgent(
  run: CommandRunner,
  args: z.infer<typeof WaitAgentArgs>,
  context: HerdrContext,
): Promise<unknown[]> {
  const cfg = cfgFrom(context);
  const ranAt = new Date().toISOString();
  const targets = dedupeTargets(args.targets);

  const outcomes = await fanOut(targets, args.failFast, async (target) => {
    assertTarget(target);
    const argv = ["agent", "wait", target];
    pushRepeated(argv, "--until", args.until);
    if (args.timeoutMs > 0) argv.push("--timeout", String(args.timeoutMs));
    const result = await herdrJson(run, cfg, argv, {
      timeoutMs: args.timeoutMs > 0
        ? args.timeoutMs + 5_000
        : Math.max(cfg.timeoutMs, 600_000),
    });
    const after = obj(result.agent);
    return {
      paneId: str(after.pane_id),
      ok: true,
      // Waiting observes state; it never changes it.
      changed: false,
      status: str(after.agent_status),
      detail: `reached ${str(after.agent_status) || "state"}`,
    };
  });

  return [await writeAction(context, "wait-agent", outcomes, ranAt)];
}

/** `start-agent` — launch an agent in a pane, unless one is already there. */
export async function runStartAgent(
  run: CommandRunner,
  args: z.infer<typeof StartAgentArgs>,
  context: HerdrContext,
): Promise<unknown[]> {
  const cfg = cfgFrom(context);
  const observedAt = new Date().toISOString();
  const pane = assertTarget(args.pane, "pane");
  assertTarget(args.name, "agent name");
  assertTarget(args.kind, "agent kind");

  const agents = await loadAgents(run, cfg);
  const existing = agents.get(pane);
  if (existing && !args.force) {
    const agent = toAgent(existing, observedAt);
    const handle = await context.writeResource(
      "agent",
      `agent-${sanitizeInstance(pane)}`,
      agent,
    );
    return [handle];
  }

  const argv = [
    "agent",
    "start",
    args.name,
    "--kind",
    args.kind,
    "--pane",
    pane,
  ];
  if (args.timeoutMs > 0) argv.push("--timeout", String(args.timeoutMs));
  if (args.agentArgs.length > 0) argv.push("--", ...args.agentArgs);
  const result = await herdrJson(run, cfg, argv, {
    timeoutMs: args.timeoutMs > 0 ? args.timeoutMs + 5_000 : cfg.timeoutMs,
  });
  const agent = toAgent(obj(result.agent), observedAt);
  const handle = await context.writeResource(
    "agent",
    `agent-${sanitizeInstance(str(agent.paneId) || pane)}`,
    agent,
  );
  return [handle];
}

/** `send-keys` — deliver key presses to panes or agents. */
export async function runSendKeys(
  run: CommandRunner,
  args: z.infer<typeof SendKeysArgs>,
  context: HerdrContext,
): Promise<unknown[]> {
  const cfg = cfgFrom(context);
  const ranAt = new Date().toISOString();
  for (const key of args.keys) assertTarget(key, "key");
  const targets = dedupeTargets(args.targets);

  const outcomes = await fanOut(targets, args.failFast, async (target) => {
    assertTarget(target);
    await herdrOk(run, cfg, [args.via, "send-keys", target, ...args.keys]);
    return {
      paneId: args.via === "pane" ? target : "",
      ok: true,
      changed: true,
      status: "",
      detail: `sent ${args.keys.join(" ")}`,
    };
  });

  return [await writeAction(context, "send-keys", outcomes, ranAt)];
}

/** `send-text` — type literal text into panes without submitting it. */
export async function runSendText(
  run: CommandRunner,
  args: z.infer<typeof SendTextArgs>,
  context: HerdrContext,
): Promise<unknown[]> {
  const cfg = cfgFrom(context);
  const ranAt = new Date().toISOString();
  const targets = dedupeTargets(args.targets);

  const outcomes = await fanOut(targets, args.failFast, async (target) => {
    assertTarget(target, "pane");
    await herdrOk(run, cfg, ["pane", "send-text", target, args.text]);
    return {
      paneId: target,
      ok: true,
      changed: true,
      status: "",
      detail: `sent ${args.text.length} character(s)`,
    };
  });

  return [await writeAction(context, "send-text", outcomes, ranAt)];
}

/** `run-command` — type a command into panes and press Enter. */
export async function runRunCommand(
  run: CommandRunner,
  args: z.infer<typeof RunCommandArgs>,
  context: HerdrContext,
): Promise<unknown[]> {
  const cfg = cfgFrom(context);
  const ranAt = new Date().toISOString();
  const targets = dedupeTargets(args.targets);

  const outcomes = await fanOut(targets, args.failFast, async (target) => {
    assertTarget(target, "pane");
    await herdrOk(run, cfg, ["pane", "run", target, args.command]);
    return {
      paneId: target,
      ok: true,
      changed: true,
      status: "",
      detail: `ran ${args.command}`,
    };
  });

  return [await writeAction(context, "run-command", outcomes, ranAt)];
}

/** `wait-output` — block until a pane's output matches text or a regex. */
export async function runWaitOutput(
  run: CommandRunner,
  args: z.infer<typeof WaitOutputArgs>,
  context: HerdrContext,
): Promise<unknown[]> {
  const cfg = cfgFrom(context);
  const pane = assertTarget(args.pane, "pane");
  if ((args.match === "") === (args.regex === "")) {
    throw new HerdrError(
      "Provide exactly one of match or regex",
      { code: "invalid_argument" },
    );
  }

  const argv = ["pane", "wait-output", pane];
  if (args.match) argv.push("--match", args.match);
  if (args.regex) argv.push("--regex", args.regex);
  argv.push("--source", args.source);
  if (args.lines > 0) argv.push("--lines", String(args.lines));
  if (args.timeoutMs > 0) argv.push("--timeout", String(args.timeoutMs));
  if (args.raw) argv.push("--raw");

  const result = await herdrJson(run, cfg, argv, {
    timeoutMs: args.timeoutMs > 0
      ? args.timeoutMs + 5_000
      : Math.max(cfg.timeoutMs, 600_000),
  });
  const read = obj(result.read);
  const bounded = boundText(str(read.text), maxOutputBytes(context));

  const handle = await context.writeResource(
    "output",
    `output-${sanitizeInstance(pane)}`,
    {
      kind: "output",
      target: pane,
      via: "pane",
      source: str(read.source) || args.source,
      format: str(read.format) || "text",
      lines: args.lines,
      paneId: str(read.pane_id) || pane,
      tabId: str(read.tab_id),
      workspaceId: str(read.workspace_id),
      agent: "",
      agentStatus: "unknown",
      text: bounded.text,
      bytes: bounded.bytes,
      truncated: bounded.truncated || bool(read.truncated),
      readAt: new Date().toISOString(),
    },
  );
  return [handle];
}

/** `create-workspace` — create a labelled workspace, or reuse it. */
export async function runCreateWorkspace(
  run: CommandRunner,
  args: z.infer<typeof CreateWorkspaceArgs>,
  context: HerdrContext,
): Promise<unknown[]> {
  const cfg = cfgFrom(context);
  const ranAt = new Date().toISOString();
  assertEnvPairs(args.env);

  if (args.reuse) {
    const listed = await herdrJson(run, cfg, ["workspace", "list"]);
    const found = arr(listed.workspaces).find((w) =>
      str(w.label) === args.label
    );
    if (found) {
      return [
        await writeContainer(context, "workspace", {
          created: false,
          reason: `reused workspace with label ${JSON.stringify(args.label)}`,
          workspaceId: str(found.workspace_id),
          tabId: str(found.active_tab_id),
          paneId: "",
          label: str(found.label),
          number: num(found.number),
          cwd: args.cwd,
          ranAt,
        }),
      ];
    }
  }

  const argv = ["workspace", "create", "--label", args.label];
  pushFlag(argv, "--cwd", args.cwd);
  pushRepeated(argv, "--env", args.env);
  pushFocus(argv, args.focus);
  const result = await herdrJson(run, cfg, argv);
  const workspace = obj(result.workspace);
  return [
    await writeContainer(context, "workspace", {
      created: true,
      reason: "created",
      workspaceId: str(workspace.workspace_id),
      tabId: str(obj(result.tab).tab_id),
      paneId: str(obj(result.root_pane).pane_id),
      label: str(workspace.label),
      number: num(workspace.number),
      cwd: args.cwd,
      ranAt,
    }),
  ];
}

/** `create-tab` — create a labelled tab in a workspace, or reuse it. */
export async function runCreateTab(
  run: CommandRunner,
  args: z.infer<typeof CreateTabArgs>,
  context: HerdrContext,
): Promise<unknown[]> {
  const cfg = cfgFrom(context);
  const ranAt = new Date().toISOString();
  assertEnvPairs(args.env);
  if (args.workspace) assertTarget(args.workspace, "workspace");

  if (args.reuse) {
    const listArgv = ["tab", "list"];
    pushFlag(listArgv, "--workspace", args.workspace);
    const listed = await herdrJson(run, cfg, listArgv);
    const found = arr(listed.tabs).find((t) =>
      str(t.label) === args.label &&
      (!args.workspace || str(t.workspace_id) === args.workspace)
    );
    if (found) {
      return [
        await writeContainer(context, "tab", {
          created: false,
          reason: `reused tab with label ${JSON.stringify(args.label)}`,
          workspaceId: str(found.workspace_id),
          tabId: str(found.tab_id),
          paneId: "",
          label: str(found.label),
          number: num(found.number),
          cwd: args.cwd,
          ranAt,
        }),
      ];
    }
  }

  const argv = ["tab", "create", "--label", args.label];
  pushFlag(argv, "--workspace", args.workspace);
  pushFlag(argv, "--cwd", args.cwd);
  pushRepeated(argv, "--env", args.env);
  pushFocus(argv, args.focus);
  const result = await herdrJson(run, cfg, argv);
  const tab = obj(result.tab);
  return [
    await writeContainer(context, "tab", {
      created: true,
      reason: "created",
      workspaceId: str(tab.workspace_id),
      tabId: str(tab.tab_id),
      paneId: str(obj(result.root_pane).pane_id),
      label: str(tab.label),
      number: num(tab.number),
      cwd: args.cwd,
      ranAt,
    }),
  ];
}

/** `split-pane` — add a pane beside or below an existing one. */
export async function runSplitPane(
  run: CommandRunner,
  args: z.infer<typeof SplitPaneArgs>,
  context: HerdrContext,
): Promise<unknown[]> {
  const cfg = cfgFrom(context);
  const ranAt = new Date().toISOString();
  const pane = assertTarget(args.pane, "pane");
  assertEnvPairs(args.env);

  // Confirm the pane exists before splitting, so a typo'd id fails with
  // herdr's own not-found error rather than a half-applied layout change.
  await herdrJson(run, cfg, ["pane", "get", pane]);

  const argv = ["pane", "split", pane, "--direction", args.direction];
  if (args.ratio > 0) argv.push("--ratio", String(args.ratio));
  pushFlag(argv, "--cwd", args.cwd);
  pushRepeated(argv, "--env", args.env);
  pushFocus(argv, args.focus);
  const result = await herdrJson(run, cfg, argv);
  const created = obj(result.pane);
  return [
    await writeContainer(context, "pane", {
      created: true,
      reason: `split ${pane} ${args.direction}`,
      workspaceId: str(created.workspace_id),
      tabId: str(created.tab_id),
      paneId: str(created.pane_id),
      label: str(created.label),
      number: 0,
      cwd: args.cwd || str(created.cwd),
      ranAt,
    }),
  ];
}

/** `create-worktree` — a Git worktree in its own workspace, or reuse one. */
export async function runCreateWorktree(
  run: CommandRunner,
  args: z.infer<typeof CreateWorktreeArgs>,
  context: HerdrContext,
): Promise<unknown[]> {
  const cfg = cfgFrom(context);
  const ranAt = new Date().toISOString();
  if (!args.branch && !args.path) {
    throw new HerdrError(
      "Provide branch, path, or both — there is nothing to identify the worktree by",
      { code: "invalid_argument" },
    );
  }

  if (args.reuse) {
    const listed = await herdrJson(run, cfg, [
      "worktree",
      "list",
      "--cwd",
      args.cwd,
    ]);
    const found = arr(listed.worktrees).find((w) =>
      (args.branch && str(w.branch) === args.branch) ||
      (args.path && str(w.path) === args.path)
    );
    if (found && str(found.open_workspace_id)) {
      return [
        await writeContainer(context, "worktree", {
          created: false,
          reason: "worktree already open in a workspace",
          workspaceId: str(found.open_workspace_id),
          tabId: "",
          paneId: "",
          label: str(found.label),
          number: 0,
          path: str(found.path),
          branch: str(found.branch),
          cwd: args.cwd,
          ranAt,
        }),
      ];
    }
    if (found) {
      const openArgv = ["worktree", "open", "--cwd", args.cwd];
      if (args.path) pushFlag(openArgv, "--path", args.path);
      else pushFlag(openArgv, "--branch", args.branch);
      pushFlag(openArgv, "--label", args.label);
      pushFocus(openArgv, args.focus);
      const opened = await herdrJson(run, cfg, openArgv);
      const worktree = obj(opened.worktree);
      return [
        await writeContainer(context, "worktree", {
          created: false,
          reason: bool(opened.already_open)
            ? "worktree already open in a workspace"
            : "opened an existing worktree",
          workspaceId: str(obj(opened.workspace).workspace_id),
          tabId: str(obj(opened.tab).tab_id),
          paneId: str(obj(opened.root_pane).pane_id),
          label: str(obj(opened.workspace).label) || str(worktree.label),
          number: num(obj(opened.workspace).number),
          path: str(worktree.path),
          branch: str(worktree.branch),
          cwd: args.cwd,
          ranAt,
        }),
      ];
    }
  }

  const argv = ["worktree", "create", "--cwd", args.cwd];
  pushFlag(argv, "--branch", args.branch);
  pushFlag(argv, "--base", args.base);
  pushFlag(argv, "--path", args.path);
  pushFlag(argv, "--label", args.label);
  pushFocus(argv, args.focus);
  const result = await herdrJson(run, cfg, argv);
  const worktree = obj(result.worktree);
  const workspace = obj(result.workspace);
  return [
    await writeContainer(context, "worktree", {
      created: true,
      reason: "created",
      workspaceId: str(workspace.workspace_id),
      tabId: str(obj(result.tab).tab_id),
      paneId: str(obj(result.root_pane).pane_id),
      label: str(workspace.label) || str(worktree.label),
      number: num(workspace.number),
      path: str(worktree.path),
      branch: str(worktree.branch),
      cwd: args.cwd,
      ranAt,
    }),
  ];
}

/** `close` — close a workspace, tab or pane; a no-op when it is already gone. */
export async function runClose(
  run: CommandRunner,
  args: z.infer<typeof CloseArgs>,
  context: HerdrContext,
  envGet: EnvGetter = defaultEnvGet,
): Promise<unknown[]> {
  const cfg = cfgFrom(context);
  const ranAt = new Date().toISOString();
  const id = assertTarget(args.id, `${args.container} id`);
  const self = selfLocationFor(cfg, envGet);

  const selfId = args.container === "workspace"
    ? self.workspaceId
    : args.container === "tab"
    ? self.tabId
    : self.paneId;
  if (!args.force && selfId && selfId === id) {
    throw new HerdrError(
      `Refusing to close ${args.container} ${id}: it hosts the pane running this method. Set force to override.`,
      { code: "self_close_refused" },
    );
  }

  // Read the live list first so a missing id is a recorded no-op rather than
  // herdr's *_not_found error — this is what makes close re-runnable.
  const listArgv = args.container === "workspace"
    ? ["workspace", "list"]
    : args.container === "tab"
    ? ["tab", "list"]
    : ["pane", "list"];
  const listed = await herdrJson(run, cfg, listArgv);
  const rows = arr(
    args.container === "workspace"
      ? listed.workspaces
      : args.container === "tab"
      ? listed.tabs
      : listed.panes,
  );
  const idKey = `${
    args.container === "workspace" ? "workspace" : args.container
  }_id`;
  const exists = rows.some((row) => str(row[idKey]) === id);

  if (!exists) {
    if (!args.missingOk) {
      throw new HerdrError(
        `${args.container} ${id} does not exist`,
        { code: `${args.container}_not_found` },
      );
    }
    return [
      await writeAction(context, "close", [{
        target: id,
        paneId: args.container === "pane" ? id : "",
        ok: true,
        changed: false,
        status: "",
        detail: `${args.container} already gone`,
      }], ranAt),
    ];
  }

  await herdrJson(run, cfg, [args.container, "close", id]);
  return [
    await writeAction(context, "close", [{
      target: id,
      paneId: args.container === "pane" ? id : "",
      ok: true,
      changed: true,
      status: "",
      detail: `${args.container} closed`,
    }], ranAt),
  ];
}

/** `notify` — raise a herdr toast on the attached client. */
export async function runNotify(
  run: CommandRunner,
  args: z.infer<typeof NotifyArgs>,
  context: HerdrContext,
): Promise<unknown[]> {
  const cfg = cfgFrom(context);
  const ranAt = new Date().toISOString();
  assertTarget(args.title, "title");

  const argv = ["notification", "show", args.title];
  pushFlag(argv, "--body", args.body);
  argv.push("--position", args.position, "--sound", args.sound);
  const result = await herdrJson(run, cfg, argv);

  // herdr answers `shown: false` with a reason when notifications are turned
  // off in config — surfaced verbatim so a silent toast is not read as sent.
  const shown = bool(result.shown);
  return [
    await writeAction(context, "notify", [{
      target: args.title,
      paneId: "",
      ok: true,
      changed: shown,
      status: shown ? "shown" : "suppressed",
      detail: shown
        ? "notification shown"
        : `notification not shown (${str(result.reason) || "unknown reason"})`,
    }], ranAt),
  ];
}

// --- server and session lifecycle -------------------------------------------

/** `server-stop` — stop the herdr server, unless it is the one hosting us. */
export async function runServerStop(
  run: CommandRunner,
  args: z.infer<typeof ServerStopArgs>,
  context: HerdrContext,
  envGet: EnvGetter = defaultEnvGet,
): Promise<unknown[]> {
  const cfg = cfgFrom(context);
  const ranAt = new Date().toISOString();
  const self = selfLocationFor(cfg, envGet);
  const target = targetLabel(cfg);

  // Stopping the local server tears down every pane it owns — including the
  // terminal this method is running in, which would kill the swamp run
  // mid-flight and take every other agent in the fleet with it.
  if (!args.force && self.inHerdr) {
    throw new HerdrError(
      `Refusing to stop the local herdr server: it hosts pane ${self.paneId}, which is running this method. Set force to override.`,
      { code: "self_stop_refused" },
    );
  }

  const { running, status } = await readServerRunning(run, cfg);
  if (!running) {
    if (!args.missingOk) {
      throw new HerdrError(
        `herdr server on ${target} is not running (status: ${
          status || "unknown"
        })`,
        { code: "server_not_running" },
      );
    }
    return [
      await writeAction(context, "server-stop", [{
        target,
        paneId: "",
        ok: true,
        changed: false,
        status: status || "not running",
        detail: "server already stopped",
      }], ranAt),
    ];
  }

  await herdrOk(run, cfg, ["server", "stop"]);
  return [
    await writeAction(context, "server-stop", [{
      target,
      paneId: "",
      ok: true,
      changed: true,
      status: "stopped",
      detail: "server stopped",
    }], ranAt),
  ];
}

/** `server-reload-config` — validate config.toml, then reload it in place. */
export async function runServerReloadConfig(
  run: CommandRunner,
  args: z.infer<typeof ServerReloadConfigArgs>,
  context: HerdrContext,
): Promise<unknown[]> {
  const cfg = cfgFrom(context);
  const ranAt = new Date().toISOString();
  const target = targetLabel(cfg);

  // Reloading an invalid config.toml is how you break a running fleet, so the
  // validation herdr already ships is run first rather than after the fact.
  let configDetail = "";
  try {
    configDetail = (await herdrText(run, cfg, ["config", "check"])).trim();
  } catch (err) {
    if (!args.force) {
      throw new HerdrError(
        `Refusing to reload: config.toml does not validate — ${
          errText(err)
        }. Set force to reload anyway.`,
        { code: "invalid_config" },
      );
    }
    configDetail = `ignored invalid config: ${errText(err)}`;
  }

  const { running, status } = await readServerRunning(run, cfg);
  if (!running) {
    return [
      await writeAction(context, "server-reload-config", [{
        target,
        paneId: "",
        ok: true,
        changed: false,
        status: status || "not running",
        detail: "no running server to reload",
      }], ranAt),
    ];
  }

  await herdrOk(run, cfg, ["server", "reload-config"]);
  return [
    await writeAction(context, "server-reload-config", [{
      target,
      paneId: "",
      ok: true,
      changed: true,
      status: "reloaded",
      detail: configDetail || "config reloaded",
    }], ranAt),
  ];
}

/** `server-live-handoff` — hand live panes to a freshly started server. */
export async function runServerLiveHandoff(
  run: CommandRunner,
  _args: z.infer<typeof ServerLiveHandoffArgs>,
  context: HerdrContext,
): Promise<unknown[]> {
  const cfg = cfgFrom(context);
  const ranAt = new Date().toISOString();
  const target = targetLabel(cfg);

  const { running, status } = await readServerRunning(run, cfg);
  if (!running) {
    throw new HerdrError(
      `No running herdr server on ${target} to hand off from (status: ${
        status || "unknown"
      })`,
      { code: "server_not_running" },
    );
  }

  await herdrOk(run, cfg, ["server", "live-handoff"]);
  return [
    await writeAction(context, "server-live-handoff", [{
      target,
      paneId: "",
      ok: true,
      changed: true,
      status: "handed off",
      detail: "live panes handed to a new server",
    }], ranAt),
  ];
}

/** `agent-manifests` — report the agent-detection manifests in force. */
export async function runAgentManifests(
  run: CommandRunner,
  _args: z.infer<typeof AgentManifestsArgs>,
  context: HerdrContext,
): Promise<unknown[]> {
  const cfg = cfgFrom(context);
  const checkedAt = new Date().toISOString();
  const result = await herdrJson(run, cfg, [
    "server",
    "agent-manifests",
    "--json",
  ]);
  return [
    await context.writeResource(
      "manifests",
      "manifests",
      toManifests(result, cfg, checkedAt, []),
    ),
  ];
}

/** `update-agent-manifests` — fetch newer manifests and report what moved. */
export async function runUpdateAgentManifests(
  run: CommandRunner,
  _args: z.infer<typeof AgentManifestsArgs>,
  context: HerdrContext,
): Promise<unknown[]> {
  const cfg = cfgFrom(context);
  const checkedAt = new Date().toISOString();

  // Read first so the run can say WHICH manifests moved. herdr's own output
  // reports the post-update state only, which cannot answer "did anything
  // change?" — the question a scheduled update actually needs answered.
  const before = new Map<string, string>();
  try {
    const prior = await herdrJson(run, cfg, [
      "server",
      "agent-manifests",
      "--json",
    ]);
    for (const row of arr(prior.manifests)) {
      before.set(str(row.agent), str(row.active_version));
    }
  } catch {
    // No baseline: the update still runs, it just reports no diff.
  }

  const result = await herdrJson(run, cfg, [
    "server",
    "update-agent-manifests",
    "--json",
  ]);
  const changedAgents = arr(result.manifests)
    .filter((row) =>
      before.size > 0 && before.get(str(row.agent)) !== str(row.active_version)
    )
    .map((row) => str(row.agent))
    .filter((agent) => agent !== "");

  return [
    await context.writeResource(
      "manifests",
      "manifests",
      toManifests(result, cfg, checkedAt, changedAgents),
    ),
  ];
}

/** `reload-agent-manifests` — reload manifests from disk, then report them. */
export async function runReloadAgentManifests(
  run: CommandRunner,
  _args: z.infer<typeof AgentManifestsArgs>,
  context: HerdrContext,
): Promise<unknown[]> {
  const cfg = cfgFrom(context);
  const checkedAt = new Date().toISOString();
  await herdrOk(run, cfg, ["server", "reload-agent-manifests"]);
  // The reload prints nothing, so the post-state is read back explicitly
  // rather than reported as an unverified success.
  const result = await herdrJson(run, cfg, [
    "server",
    "agent-manifests",
    "--json",
  ]);
  return [
    await context.writeResource(
      "manifests",
      "manifests",
      toManifests(result, cfg, checkedAt, []),
    ),
  ];
}

/** Which named session this instance is driving, for the self guard. */
function sessionInUse(cfg: HerdrConfig, self: SelfLocation): string {
  if (!self.inHerdr) return "";
  return cfg.session || "default";
}

/** `session-stop` — stop a named session, unless we are running inside it. */
export async function runSessionStop(
  run: CommandRunner,
  args: z.infer<typeof SessionStopArgs>,
  context: HerdrContext,
  envGet: EnvGetter = defaultEnvGet,
): Promise<unknown[]> {
  const cfg = cfgFrom(context);
  const ranAt = new Date().toISOString();
  const name = assertTarget(args.name, "session name");
  const self = selfLocationFor(cfg, envGet);

  if (!args.force && name === sessionInUse(cfg, self)) {
    throw new HerdrError(
      `Refusing to stop session ${
        JSON.stringify(name)
      }: it hosts the pane running this method. Set force to override.`,
      { code: "self_stop_refused" },
    );
  }

  const sessions = await readSessions(run, cfg);
  const found = sessions.find((s) => str(s.name) === name);
  if (!found || !bool(found.running)) {
    if (!found && !args.missingOk) {
      throw new HerdrError(`Session ${JSON.stringify(name)} does not exist`, {
        code: "session_not_found",
      });
    }
    return [
      await writeAction(context, "session-stop", [{
        target: name,
        paneId: "",
        ok: true,
        changed: false,
        status: found ? "stopped" : "absent",
        detail: found ? "session already stopped" : "session does not exist",
      }], ranAt),
    ];
  }

  await herdrOk(run, cfg, ["session", "stop", name, "--json"]);
  return [
    await writeAction(context, "session-stop", [{
      target: name,
      paneId: "",
      ok: true,
      changed: true,
      status: "stopped",
      detail: "session stopped",
    }], ranAt),
  ];
}

/** `session-delete` — delete a named session that is not running. */
export async function runSessionDelete(
  run: CommandRunner,
  args: z.infer<typeof SessionDeleteArgs>,
  context: HerdrContext,
  envGet: EnvGetter = defaultEnvGet,
): Promise<unknown[]> {
  const cfg = cfgFrom(context);
  const ranAt = new Date().toISOString();
  const name = assertTarget(args.name, "session name");
  const self = selfLocationFor(cfg, envGet);

  if (!args.force && name === sessionInUse(cfg, self)) {
    throw new HerdrError(
      `Refusing to delete session ${
        JSON.stringify(name)
      }: it hosts the pane running this method. Set force to override.`,
      { code: "self_delete_refused" },
    );
  }

  const sessions = await readSessions(run, cfg);
  const found = sessions.find((s) => str(s.name) === name);
  if (!found) {
    if (!args.missingOk) {
      throw new HerdrError(`Session ${JSON.stringify(name)} does not exist`, {
        code: "session_not_found",
      });
    }
    return [
      await writeAction(context, "session-delete", [{
        target: name,
        paneId: "",
        ok: true,
        changed: false,
        status: "absent",
        detail: "session does not exist",
      }], ranAt),
    ];
  }
  // Deleting a live session discards running panes and their agents, so a
  // running one needs the caller to say so explicitly.
  if (bool(found.running) && !args.force) {
    throw new HerdrError(
      `Session ${
        JSON.stringify(name)
      } is still running — stop it first, or set force to delete it anyway.`,
      { code: "session_running" },
    );
  }

  await herdrOk(run, cfg, ["session", "delete", name, "--json"]);
  return [
    await writeAction(context, "session-delete", [{
      target: name,
      paneId: "",
      ok: true,
      changed: true,
      status: "deleted",
      detail: "session deleted",
    }], ranAt),
  ];
}

/** Persist a created-or-reused container. */
async function writeContainer(
  context: HerdrContext,
  container: "workspace" | "tab" | "pane" | "worktree",
  fields: {
    created: boolean;
    reason: string;
    workspaceId: string;
    tabId: string;
    paneId: string;
    label: string;
    number: number;
    path?: string;
    branch?: string;
    cwd: string;
    ranAt: string;
  },
): Promise<unknown> {
  // The instance name must key on the container's OWN identity, never on
  // "the most specific id this particular run happened to learn". A create
  // knows the new root pane; the matching reuse does not — keying on the
  // pane would file the two runs under different instances, so `data.latest`
  // on the create's instance would keep answering "created: true" long after
  // the reuse said otherwise. Same container, same instance, new version.
  const key = container === "pane"
    ? fields.paneId
    : container === "tab"
    ? fields.tabId
    : fields.workspaceId;
  return await context.writeResource(
    "container",
    `container-${container}-${sanitizeInstance(key)}`,
    {
      kind: "container",
      container,
      created: fields.created,
      reason: fields.reason,
      workspaceId: fields.workspaceId,
      tabId: fields.tabId,
      paneId: fields.paneId,
      label: fields.label,
      number: fields.number,
      path: fields.path ?? "",
      branch: fields.branch ?? "",
      cwd: fields.cwd,
      ranAt: fields.ranAt,
    },
  );
}

// --- Model -------------------------------------------------------------------

export const model = {
  type: "@magistr/herdr",
  version: "2026.08.19.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    status: {
      description:
        "herdr client/server health: versions, protocol compatibility, socket path and named sessions",
      schema: StatusSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    fleet: {
      description:
        "Whole-session roll-up: workspaces, tabs, pane count and every agent with its state",
      schema: FleetSchema,
      lifetime: "infinite",
      garbageCollection: 20,
    },
    agent: {
      description:
        "One agent in one pane: kind, state, cwd, terminal title and the agent's own session id",
      schema: AgentSchema,
      lifetime: "infinite",
      garbageCollection: 5,
    },
    output: {
      description: "Terminal text captured from a pane or agent",
      schema: OutputSchema,
      lifetime: "infinite",
      garbageCollection: 5,
    },
    action: {
      description:
        "Outcome of a control method, one row per target, with what changed and what was skipped",
      schema: ActionSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    container: {
      description:
        "A workspace, tab, pane or worktree that a method created or reused",
      schema: ContainerSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    manifests: {
      description:
        "Agent-detection manifests in force on the server: per-agent version, source and staleness",
      schema: ManifestsSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  methods: {
    "status": {
      description:
        "Health check: client and server versions, protocol compatibility, the socket in use and every named session. Works whether or not a server is running — a stopped server reports serverRunning false instead of failing.",
      arguments: StatusArgs,
      execute: async (args, context) => ({
        dataHandles: await runStatus(defaultRunner, args, context),
      }),
    },

    "snapshot": {
      description:
        "Read the entire herdr session in one socket round-trip and write a fleet roll-up plus one agent resource per agent. The fan-out read: use this instead of looping per-workspace calls. Filter by workspace (id or label) and by agent state.",
      arguments: SnapshotArgs,
      execute: async (args, context) => ({
        dataHandles: await runSnapshot(defaultRunner, args, context),
      }),
    },

    "read": {
      description:
        "Capture what a pane or agent is showing — the visible screen, the scrollback tail, or (agents only) the classifier's own detection buffer. Text is bounded by maxOutputBytes and tagged with the pane/tab/workspace it came from.",
      arguments: ReadArgs,
      execute: async (args, context) => ({
        dataHandles: await runRead(defaultRunner, args, context),
      }),
    },

    "prompt": {
      description:
        "Submit a prompt to one or many agents in a single run. Optionally waits for each agent to settle. The pane running this method is skipped by default, because an agent that prompts itself waits on its own turn forever.",
      arguments: PromptArgs,
      execute: async (args, context) => ({
        dataHandles: await runPrompt(defaultRunner, args, context),
      }),
    },

    "wait-agent": {
      description:
        "Block until agents reach one of the given states (default idle). Read-only: it observes state transitions and never changes them. Fans out over every target in one run.",
      arguments: WaitAgentArgs,
      execute: async (args, context) => ({
        dataHandles: await runWaitAgent(defaultRunner, args, context),
      }),
    },

    "start-agent": {
      description:
        "Launch an agent of the given kind in a pane. Idempotent: a pane that already hosts an agent is left running and its current state is recorded instead, unless force is set.",
      arguments: StartAgentArgs,
      execute: async (args, context) => ({
        dataHandles: await runStartAgent(defaultRunner, args, context),
      }),
    },

    "send-keys": {
      description:
        "Deliver key presses (enter, esc, ctrl+c, shift+tab, f1, …) to panes or named agents. Use this rather than send-text for control keys and for submitting input.",
      arguments: SendKeysArgs,
      execute: async (args, context) => ({
        dataHandles: await runSendKeys(defaultRunner, args, context),
      }),
    },

    "send-text": {
      description:
        "Type literal text into panes without submitting it — the text lands at the cursor and Enter is not sent. Use run-command to type and submit in one step.",
      arguments: SendTextArgs,
      execute: async (args, context) => ({
        dataHandles: await runSendText(defaultRunner, args, context),
      }),
    },

    "run-command": {
      description:
        "Type a shell command into panes and submit it with Enter. Fans out over targets so one call drives a whole row of panes.",
      arguments: RunCommandArgs,
      execute: async (args, context) => ({
        dataHandles: await runRunCommand(defaultRunner, args, context),
      }),
    },

    "wait-output": {
      description:
        "Block until a pane's output matches a literal string or a regex, then write the matching capture. The building block for 'run something, then continue when it prints X'.",
      arguments: WaitOutputArgs,
      execute: async (args, context) => ({
        dataHandles: await runWaitOutput(defaultRunner, args, context),
      }),
    },

    "create-workspace": {
      description:
        "Create a labelled workspace. Idempotent by label: an existing workspace with the same label is returned untouched (created false) unless reuse is disabled.",
      arguments: CreateWorkspaceArgs,
      execute: async (args, context) => ({
        dataHandles: await runCreateWorkspace(defaultRunner, args, context),
      }),
    },

    "create-tab": {
      description:
        "Create a labelled tab in a workspace. Idempotent by label within that workspace: an existing tab is returned untouched (created false) unless reuse is disabled.",
      arguments: CreateTabArgs,
      execute: async (args, context) => ({
        dataHandles: await runCreateTab(defaultRunner, args, context),
      }),
    },

    "split-pane": {
      description:
        "Split a pane right or down, optionally with a size ratio, cwd and environment. Verifies the pane exists first. Not idempotent by nature — each call adds a pane.",
      arguments: SplitPaneArgs,
      execute: async (args, context) => ({
        dataHandles: await runSplitPane(defaultRunner, args, context),
      }),
    },

    "create-worktree": {
      description:
        "Cut a Git worktree and open it in its own workspace — the isolated-branch primitive for parallel agents. Idempotent: an existing worktree for the branch is opened (or reported already-open) rather than recreated.",
      arguments: CreateWorktreeArgs,
      execute: async (args, context) => ({
        dataHandles: await runCreateWorktree(defaultRunner, args, context),
      }),
    },

    "close": {
      description:
        "Close a workspace, tab or pane. Reads the live list first: an id that is already gone is a recorded no-op, not an error. Refuses to close the pane/tab/workspace running this method unless force is set.",
      arguments: CloseArgs,
      execute: async (args, context) => ({
        dataHandles: await runClose(defaultRunner, args, context),
      }),
    },

    "notify": {
      description:
        "Raise a herdr toast on the attached client. Records whether it was actually shown — herdr answers with a reason when notifications are disabled in config.",
      arguments: NotifyArgs,
      execute: async (args, context) => ({
        dataHandles: await runNotify(defaultRunner, args, context),
      }),
    },

    "server-stop": {
      description:
        "Stop the herdr server. Reads its state first, so an already-stopped server is a no-op. Refuses to stop a LOCAL server that hosts the pane running this method — that would kill the swamp run and every agent with it — unless force is set.",
      arguments: ServerStopArgs,
      execute: async (args, context) => ({
        dataHandles: await runServerStop(defaultRunner, args, context),
      }),
    },

    "server-reload-config": {
      description:
        "Reload config.toml in the running server, after validating it with herdr's own config check. An invalid config is refused rather than reloaded into a live fleet, unless force is set.",
      arguments: ServerReloadConfigArgs,
      execute: async (args, context) => ({
        dataHandles: await runServerReloadConfig(defaultRunner, args, context),
      }),
    },

    "server-live-handoff": {
      description:
        "Hand the live panes of a running server to a freshly started one — the mechanism behind an in-place herdr upgrade. Fails when no server is running rather than silently doing nothing.",
      arguments: ServerLiveHandoffArgs,
      execute: async (args, context) => ({
        dataHandles: await runServerLiveHandoff(defaultRunner, args, context),
      }),
    },

    "agent-manifests": {
      description:
        "Report the agent-detection manifests the server is using: per-agent active version, whether it came from the bundle or a remote fetch, and any manifest herdr rejected. Read-only.",
      arguments: AgentManifestsArgs,
      execute: async (args, context) => ({
        dataHandles: await runAgentManifests(defaultRunner, args, context),
      }),
    },

    "update-agent-manifests": {
      description:
        "Fetch newer agent-detection manifests and reload them. Reads the current versions first so the result names exactly which agents moved — herdr's own output reports only the post-update state.",
      arguments: AgentManifestsArgs,
      execute: async (args, context) => ({
        dataHandles: await runUpdateAgentManifests(
          defaultRunner,
          args,
          context,
        ),
      }),
    },

    "reload-agent-manifests": {
      description:
        "Reload agent-detection manifests from disk without fetching, then read the resulting state back — the reload itself prints nothing, so success is verified rather than assumed.",
      arguments: AgentManifestsArgs,
      execute: async (args, context) => ({
        dataHandles: await runReloadAgentManifests(
          defaultRunner,
          args,
          context,
        ),
      }),
    },

    "session-stop": {
      description:
        "Stop a named herdr session. Reads the session inventory first: an unknown or already-stopped session is a no-op. Refuses to stop the session hosting this method unless force is set.",
      arguments: SessionStopArgs,
      execute: async (args, context) => ({
        dataHandles: await runSessionStop(defaultRunner, args, context),
      }),
    },

    "session-delete": {
      description:
        "Delete a named herdr session. A session that is still running is refused rather than discarded with its panes and agents, unless force is set; an unknown session is a no-op.",
      arguments: SessionDeleteArgs,
      execute: async (args, context) => ({
        dataHandles: await runSessionDelete(defaultRunner, args, context),
      }),
    },
  },
};
