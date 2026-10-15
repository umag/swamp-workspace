import { z } from "npm:zod@4";
import { compact, type CompactResult } from "./lib/compactor.ts";
import { claudeCli, type SessionFactory } from "./lib/llm.ts";
import { agentKind, systemPrompt } from "./lib/prompts.ts";
import { ChatStore, DEFAULT_LIMITS } from "./lib/store.ts";
import { MCP_NAME, runTurn } from "./lib/turn.ts";
import { labelOf } from "./lib/tree.ts";

// =============================================================================
// @magistr/optchat
// One chat that never ends (Taelin's OptChat / UniiChat design). Every message
// is logged word for word in an append-only chat directory; a cheap model
// compresses the log into a binary tree of 512-byte lines; each turn sees the
// view — lines covering the whole chat, fine when recent and coarse when old,
// 64-128 KB — and zooms into a line when it needs more. Turns and compactions
// run through the local `claude -p` (Claude Code subscription, no API key).
// =============================================================================

const GlobalArgsSchema = z.object({
  chatDir: z.string().min(1).describe(
    "Directory holding the chat (main/, tree/, view.json). Created if missing. A leading ~/ means $HOME.",
  ),
  agentName: z.string().min(1).default("Unii").describe(
    "The agent's name in the system prompt; its replies are logged with this name, lowercased, as their kind.",
  ),
  userInstructions: z.string().default("").describe(
    "Who the user is, how their files are organized, how they want work done. Appended to the system prompt.",
  ),
  turnModel: z.string().default("opus").describe(
    "Model for turns (a claude --model value).",
  ),
  turnEffort: z.string().default("").describe(
    "Effort for turns (low, medium, high, xhigh, max); empty leaves the CLI default.",
  ),
  compactModel: z.string().default("haiku").describe(
    "Cheap model for compactions.",
  ),
  compactEffort: z.string().default("xhigh").describe(
    "Effort for compactions; empty leaves the CLI default.",
  ),
  turnTools: z.array(z.string()).default([
    "Read",
    "Glob",
    "Grep",
    "WebSearch",
    "WebFetch",
  ]).describe(
    "Built-in Claude Code tools the agent may use for the user's tasks (zoom and date are always on). Add Bash, Write, Edit to let it change things.",
  ),
  workDir: z.string().default("").describe(
    "Working directory for turns; empty means chatDir.",
  ),
  concurrency: z.number().int().min(1).max(32).default(8).describe(
    "Compactions run at once.",
  ),
  viewHighBytes: z.number().int().positive().default(DEFAULT_LIMITS.high)
    .describe("A batch merge starts once the view passes this."),
  viewLowBytes: z.number().int().positive().default(DEFAULT_LIMITS.low)
    .describe("A batch merges the view down to this."),
  compactHighBytes: z.number().int().positive().default(
    DEFAULT_LIMITS.compactHigh,
  ).describe("The compaction view is merged again once it passes this."),
  compactLowBytes: z.number().int().positive().default(
    DEFAULT_LIMITS.compactLow,
  ).describe("The compaction view is merged down to this."),
  turnTimeoutSeconds: z.number().int().positive().default(1800),
  compactTimeoutSeconds: z.number().int().positive().default(300),
  lockStaleMinutes: z.number().int().positive().default(60).describe(
    "A chat lock older than this is taken over.",
  ),
  claudeBin: z.string().default("claude"),
  denoBin: z.string().default("deno").describe(
    "Deno binary that runs the zoom/date MCP server during turns.",
  ),
});

type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

// ---------- Resource schemas -------------------------------------------------

const StatusSchema = z.object({
  chatDir: z.string(),
  messages: z.number(),
  nodes: z.number(),
  pendingNodes: z.number(),
  leavesBuilt: z.boolean(),
  viewLines: z.number(),
  viewBytes: z.number(),
  compactionViewLines: z.number(),
  compactionViewBytes: z.number(),
  merging: z.boolean(),
  levels: z.record(z.string(), z.number()),
  timestamp: z.string(),
});

const AppendSchema = z.object({
  kind: z.string(),
  messageIds: z.array(z.number()),
  bytes: z.number(),
  timestamp: z.string(),
});

const CompactionSchema = z.object({
  built: z.number(),
  calls: z.number(),
  failed: z.array(z.object({ node: z.string(), error: z.string() })),
  pending: z.number(),
  durationMs: z.number(),
  timestamp: z.string(),
});

const TurnSchema = z.object({
  message: z.string(),
  reply: z.string(),
  messageIds: z.array(z.number()),
  toolCalls: z.number(),
  costUsd: z.number().nullable(),
  usage: z.record(z.string(), z.unknown()).nullable(),
  viewBytes: z.number(),
  durationMs: z.number(),
  before: CompactionSchema.nullable(),
  after: CompactionSchema.nullable(),
  timestamp: z.string(),
});

const ViewSchema = z.object({
  messages: z.number(),
  lines: z.number(),
  bytes: z.number(),
  text: z.string(),
  timestamp: z.string(),
});

const ZoomSchema = z.object({
  id: z.number(),
  n: z.number(),
  text: z.string(),
  timestamp: z.string(),
});

// ---------- Context ----------------------------------------------------------

interface Ctx {
  globalArgs: unknown;
  logger: { info: (msg: string, meta?: Record<string, unknown>) => void };
  writeResource: (
    spec: string,
    name: string,
    data: Record<string, unknown>,
  ) => Promise<unknown>;
  extensionFile?: (path: string) => string;
  /** Test seam: replaces the claude CLI. */
  sessionFactory?: SessionFactory;
}

const MCP_SERVER_PATH = "extensions/models/lib/mcp_server.ts";

function expandHome(p: string): string {
  if (p === "~" || p.startsWith("~/")) {
    return (Deno.env.get("HOME") ?? "") + p.slice(1);
  }
  return p;
}

function globals(context: Ctx): GlobalArgs {
  const g = GlobalArgsSchema.parse(context.globalArgs);
  return { ...g, chatDir: expandHome(g.chatDir) };
}

async function openStore(g: GlobalArgs, lock: boolean): Promise<ChatStore> {
  return await ChatStore.open(g.chatDir, {
    lock,
    lockStaleMinutes: g.lockStaleMinutes,
    limits: {
      high: g.viewHighBytes,
      low: g.viewLowBytes,
      compactHigh: g.compactHighBytes,
      compactLow: g.compactLowBytes,
    },
  });
}

function factoryOf(g: GlobalArgs, context: Ctx): SessionFactory {
  return context.sessionFactory ?? claudeCli(g.claudeBin);
}

async function runCompaction(
  store: ChatStore,
  g: GlobalArgs,
  context: Ctx,
  extra: { maxCalls?: number; untilLeavesBuilt?: boolean } = {},
): Promise<z.infer<typeof CompactionSchema>> {
  const started = Date.now();
  const r: CompactResult = await compact(store, {
    factory: factoryOf(g, context),
    model: g.compactModel,
    effort: g.compactEffort || undefined,
    systemPrompt: systemPrompt(g.agentName, g.userInstructions),
    concurrency: g.concurrency,
    timeoutMs: g.compactTimeoutSeconds * 1000,
    ...extra,
  });
  return {
    ...r,
    durationMs: Date.now() - started,
    timestamp: new Date().toISOString(),
  };
}

/** The status snapshot of an open chat. */
export function statusOf(store: ChatStore, chatDir: string) {
  const levels: Record<string, number> = {};
  for (const [l] of store.view.chat) {
    levels[String(l)] = (levels[String(l)] ?? 0) + 1;
  }
  return {
    chatDir,
    messages: store.T,
    nodes: store.nodeCount,
    pendingNodes: store.pending,
    leavesBuilt: store.leavesBuilt,
    viewLines: store.view.chat.length,
    viewBytes: store.viewBytes(),
    compactionViewLines: store.view.compact.length,
    compactionViewBytes: store.viewBytes(store.view.compact),
    merging: store.view.merging,
    levels,
    timestamp: new Date().toISOString(),
  };
}

/** The --mcp-config JSON that serves zoom and date over the chat dir. */
export function mcpConfigFor(
  denoBin: string,
  serverPath: string,
  chatDir: string,
): string {
  return JSON.stringify({
    mcpServers: {
      [MCP_NAME]: {
        type: "stdio",
        command: denoBin,
        args: [
          "run",
          "--no-config",
          "--no-lock",
          `--allow-read=${chatDir}`,
          serverPath,
          chatDir,
        ],
      },
    },
  });
}

async function withStore<T>(
  g: GlobalArgs,
  lock: boolean,
  fn: (store: ChatStore) => T | Promise<T>,
): Promise<T> {
  const store = await openStore(g, lock);
  try {
    return await fn(store);
  } finally {
    await store.close();
  }
}

/** The @magistr/optchat model: a never-ending chat with tree memory. */
export const model = {
  type: "@magistr/optchat",
  version: "2026.10.15.5",
  upgrades: [
    {
      toVersion: "2026.10.15.1",
      description: "Version bump — repo-wide republish; no schema change",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.10.15.2",
      description: "Version bump — repo-wide republish; no schema change",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.10.15.3",
      description: "Version bump — repo-wide republish; no schema change",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.10.15.4",
      description: "Version bump — repo-wide republish; no schema change",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.10.15.5",
      description: "Version bump — repo-wide republish; no schema change",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
  ],
  globalArguments: GlobalArgsSchema,
  resources: {
    status: {
      description:
        "Chat size, built and pending tree nodes, and the view's lines, bytes and lines per level.",
      schema: StatusSchema,
      lifetime: "infinite",
      garbageCollection: 20,
    },
    append: {
      description: "Messages logged by an append, without a model call.",
      schema: AppendSchema,
      lifetime: "infinite",
      garbageCollection: 20,
    },
    compaction: {
      description:
        "One compaction run: nodes built, model calls made, failures and nodes still pending.",
      schema: CompactionSchema,
      lifetime: "infinite",
      garbageCollection: 20,
    },
    turn: {
      description:
        "One turn: the user's message, the agent's final reply, the ids logged, tool calls, cost and usage, and the compactions around it.",
      schema: TurnSchema,
      lifetime: "infinite",
      garbageCollection: 200,
    },
    view: {
      description:
        "The view as the next turn would see it, inside <chat> tags.",
      schema: ViewSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    zoom: {
      description:
        "A zoom into one line: its two halves, or the message whole when n = 1.",
      schema: ZoomSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  methods: {
    status: {
      description: "Report the chat's size, tree and view (read only).",
      arguments: z.object({}),
      execute: async (_args: Record<string, unknown>, context: Ctx) => {
        const g = globals(context);
        const status = await withStore(
          g,
          false,
          (store) => statusOf(store, g.chatDir),
        );
        const handle = await context.writeResource("status", "status", status);
        return { dataHandles: [handle] };
      },
    },

    append: {
      description:
        "Log text as messages without a model call: notes imported from before the chat (kind note), a subagent report (work), or a user message to answer later.",
      arguments: z.object({
        text: z.string().min(1).describe("The text to log, whole."),
        kind: z.enum(["note", "work", "user"]).default("note"),
      }),
      execute: async (rawArgs: Record<string, unknown>, context: Ctx) => {
        const args = z.object({
          text: z.string().min(1),
          kind: z.enum(["note", "work", "user"]).default("note"),
        }).parse(rawArgs);
        const g = globals(context);
        const msgs = await withStore(
          g,
          true,
          (store) => store.append(args.kind, args.text),
        );
        const handle = await context.writeResource("append", "append", {
          kind: args.kind,
          messageIds: msgs.map((m) => m.i),
          bytes: msgs.reduce((s, m) => s + m.size, 0),
          timestamp: new Date().toISOString(),
        });
        context.logger.info("logged {count} message(s)", {
          count: msgs.length,
        });
        return { dataHandles: [handle] };
      },
    },

    compact: {
      description:
        "Build every ready tree node with the compaction model, up to `concurrency` at once. Idempotent: built nodes are never rebuilt; failed ones are retried on the next run.",
      arguments: z.object({
        maxCalls: z.number().int().positive().optional().describe(
          "Stop starting model calls after this many.",
        ),
      }),
      execute: async (rawArgs: Record<string, unknown>, context: Ctx) => {
        const args = z.object({
          maxCalls: z.number().int().positive().optional(),
        }).parse(rawArgs);
        const g = globals(context);
        const [run, status] = await withStore(g, true, async (store) => {
          const run = await runCompaction(store, g, context, {
            maxCalls: args.maxCalls,
          });
          return [run, statusOf(store, g.chatDir)] as const;
        });
        context.logger.info(
          "built {built} node(s) with {calls} call(s), {failed} failed, {pending} pending",
          {
            built: run.built,
            calls: run.calls,
            failed: run.failed.length,
            pending: run.pending,
          },
        );
        const handles = [
          await context.writeResource("compaction", "compaction", run),
          await context.writeResource("status", "status", status),
        ];
        return { dataHandles: handles };
      },
    },

    turn: {
      description:
        "Answer one user message: summarize every earlier message, call the turn model with the view and the message in a fresh conversation (zoom and date served over MCP), log each reply, tool call and result, then compact.",
      arguments: z.object({
        message: z.string().min(1).describe("The user's new message."),
        compactAfter: z.boolean().default(true).describe(
          "Compact the turn's own messages afterwards, so the next turn starts at once.",
        ),
      }),
      execute: async (rawArgs: Record<string, unknown>, context: Ctx) => {
        const args = z.object({
          message: z.string().min(1),
          compactAfter: z.boolean().default(true),
        }).parse(rawArgs);
        const g = globals(context);
        const serverPath = context.extensionFile
          ? context.extensionFile(MCP_SERVER_PATH)
          : new URL(`./lib/mcp_server.ts`, import.meta.url).pathname;
        const record = await withStore(g, true, async (store) => {
          const before = store.leavesBuilt ? null : await runCompaction(
            store,
            g,
            context,
            { untilLeavesBuilt: true },
          );
          const result = await runTurn(store, args.message, {
            factory: factoryOf(g, context),
            model: g.turnModel,
            effort: g.turnEffort || undefined,
            systemPrompt: systemPrompt(g.agentName, g.userInstructions),
            agentKind: agentKind(g.agentName),
            tools: g.turnTools,
            mcpConfig: mcpConfigFor(g.denoBin, serverPath, g.chatDir),
            cwd: expandHome(g.workDir || g.chatDir),
            timeoutMs: g.turnTimeoutSeconds * 1000,
          });
          const after = args.compactAfter
            ? await runCompaction(store, g, context)
            : null;
          return {
            message: args.message,
            ...result,
            before,
            after,
            timestamp: new Date().toISOString(),
          };
        });
        context.logger.info("{reply}", { reply: record.reply });
        const handle = await context.writeResource("turn", "turn", record);
        return { dataHandles: [handle] };
      },
    },

    view: {
      description: "Render the view as the next turn would see it (read only).",
      arguments: z.object({}),
      execute: async (_args: Record<string, unknown>, context: Ctx) => {
        const g = globals(context);
        const data = await withStore(g, false, (store) => ({
          messages: store.T,
          lines: store.view.chat.length,
          bytes: store.viewBytes(),
          text: store.renderView(),
          timestamp: new Date().toISOString(),
        }));
        const handle = await context.writeResource("view", "view", data);
        return { dataHandles: [handle] };
      },
    },

    zoom: {
      description:
        "Open line id+n into the two lines under it, or message id whole when n = 1 (read only).",
      arguments: z.object({
        id: z.number().int().min(0),
        n: z.number().int().min(1).default(1),
      }),
      execute: async (rawArgs: Record<string, unknown>, context: Ctx) => {
        const args = z.object({
          id: z.number().int().min(0),
          n: z.number().int().min(1).default(1),
        }).parse(rawArgs);
        const g = globals(context);
        const text = await withStore(
          g,
          false,
          (store) => store.zoom(args.id, args.n),
        );
        const handle = await context.writeResource("zoom", "zoom", {
          id: args.id,
          n: args.n,
          text,
          timestamp: new Date().toISOString(),
        });
        context.logger.info("zoomed {line}", {
          line: labelOf([Math.log2(args.n), args.id / args.n]),
        });
        return { dataHandles: [handle] };
      },
    },
  },
};
