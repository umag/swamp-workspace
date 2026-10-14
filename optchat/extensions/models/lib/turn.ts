// =============================================================================
// A turn: render the view, log the user's message, and call the model in a
// fresh conversation with [system] [view] [per-turn state] [message]. Each
// reply, tool call and tool result is logged as it happens. Thoughts are
// shown to no one and never logged. Nothing carries over between turns.
// =============================================================================

import type { SessionFactory, StreamEvent } from "./llm.ts";
import type { ChatStore } from "./store.ts";

/** MCP server name for the zoom and date tools. */
export const MCP_NAME = "optchat";

/** How a turn runs. */
export interface TurnOptions {
  factory: SessionFactory;
  model: string;
  effort?: string;
  systemPrompt: string;
  /** Kind of the agent's replies. */
  agentKind: string;
  /** Built-in tools the agent may use for the user's tasks. */
  tools: string[];
  /** MCP config JSON serving zoom and date. */
  mcpConfig: string;
  cwd?: string;
  timeoutMs: number;
  now?: Date;
}

/** What a turn did. */
export interface TurnResult {
  reply: string;
  /** Ids of every message the turn logged, the user's included. */
  messageIds: number[];
  toolCalls: number;
  costUsd: number | null;
  usage: Record<string, unknown> | null;
  viewBytes: number;
  durationMs: number;
}

interface Block {
  type?: string;
  text?: string;
  name?: string;
  input?: unknown;
  content?: unknown;
  is_error?: boolean;
}

function blocksOf(event: StreamEvent): Block[] {
  const msg = event.message as { content?: unknown } | undefined;
  return Array.isArray(msg?.content) ? msg.content as Block[] : [];
}

function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((c) =>
      typeof c === "object" && c && "text" in c
        ? String((c as { text: unknown }).text)
        : `[${(c as { type?: string })?.type ?? "content"}]`
    ).join("\n");
  }
  return JSON.stringify(content ?? "");
}

/** Short tool name: an `mcp__optchat__` prefix is dropped. */
export function toolName(name: string): string {
  const prefix = `mcp__${MCP_NAME}__`;
  return name.startsWith(prefix) ? name.slice(prefix.length) : name;
}

/** The messages a stream event becomes, as [kind, text] pairs. */
export function eventMessages(
  event: StreamEvent,
  agentKind: string,
): [string, string][] {
  const out: [string, string][] = [];
  if (event.type === "assistant") {
    for (const b of blocksOf(event)) {
      if (b.type === "text" && b.text?.trim()) out.push([agentKind, b.text]);
      if (b.type === "tool_use") {
        out.push([
          "tool",
          `${toolName(b.name ?? "?")} ${JSON.stringify(b.input ?? {})}`,
        ]);
      }
    }
  } else if (event.type === "user") {
    for (const b of blocksOf(event)) {
      if (b.type !== "tool_result") continue;
      const text = resultText(b.content);
      out.push(["echo", b.is_error ? `error: ${text}` : text]);
    }
  }
  return out;
}

/** The input of a turn: the view, the per-turn state, then the message. */
export function turnInput(view: string, message: string, now: Date): string {
  return `${view}\n\nNow: ${now.toISOString()}\n\n${message}`;
}

/** Run one turn. The caller has built every leaf before calling. */
export async function runTurn(
  store: ChatStore,
  message: string,
  opts: TurnOptions,
): Promise<TurnResult> {
  const started = Date.now();
  const now = opts.now ?? new Date();
  const view = store.renderView();
  const viewBytes = store.viewBytes();
  const ids = (await store.append("user", message, now)).map((m) => m.i);
  let toolCalls = 0;
  let chain: Promise<void> = Promise.resolve();
  const onEvent = (event: StreamEvent) => {
    for (const [kind, text] of eventMessages(event, opts.agentKind)) {
      if (kind === "tool") toolCalls++;
      chain = chain.then(async () => {
        for (const m of await store.append(kind, text)) ids.push(m.i);
      });
    }
  };
  const session = opts.factory({
    model: opts.model,
    effort: opts.effort,
    systemPrompt: opts.systemPrompt,
    tools: opts.tools,
    allowedTools: [
      ...opts.tools,
      `mcp__${MCP_NAME}__zoom`,
      `mcp__${MCP_NAME}__date`,
    ],
    mcpConfig: opts.mcpConfig,
    cwd: opts.cwd,
    timeoutMs: opts.timeoutMs,
  });
  try {
    const reply = await session.send(turnInput(view, message, now), onEvent);
    await chain;
    return {
      reply: reply.text,
      messageIds: ids,
      toolCalls,
      costUsd: typeof reply.result.total_cost_usd === "number"
        ? reply.result.total_cost_usd
        : null,
      usage: (reply.result.usage as Record<string, unknown>) ?? null,
      viewBytes,
      durationMs: Date.now() - started,
    };
  } finally {
    await chain.catch(() => {});
    await session.close();
  }
}
