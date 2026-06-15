// Minimal Anthropic Messages API client. Mirrors the @keeb/anthropic/claude
// request contract for a standard API key (x-api-key), and additionally accepts
// a Claude Code OAuth token (Authorization: Bearer + the oauth beta header,
// with the Claude Code system identity prepended). Used in-process by the
// comfyui model's generate_caption method.

export interface ClaudeOptions {
  /** A standard `sk-ant-api…` API key, or a `sk-ant-oat…` Claude Code OAuth token. */
  apiKey: string;
  model: string;
  maxTokens?: number;
  system?: string;
  fetchImpl?: typeof fetch;
}

interface MessagesResponse {
  content?: Array<{ type: string; text?: string }>;
}

const CLAUDE_CODE_IDENTITY =
  "You are Claude Code, Anthropic's official CLI for Claude.";

/** True for a Claude Code OAuth token (vs a standard `sk-ant-api…` API key). */
export function isOAuthToken(key: string): boolean {
  return key.startsWith("sk-ant-oat");
}

/**
 * Send a single user message to Claude and return the concatenated text output.
 * Auto-selects x-api-key vs OAuth Bearer auth from the token shape. Throws on a
 * non-2xx response, surfacing the API error body.
 */
export async function claudeComplete(
  userMessage: string,
  opts: ClaudeOptions,
): Promise<string> {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const oauth = isOAuthToken(opts.apiKey);

  const headers: Record<string, string> = {
    "content-type": "application/json",
    "anthropic-version": "2023-06-01",
  };
  if (oauth) {
    headers["authorization"] = `Bearer ${opts.apiKey}`;
    headers["anthropic-beta"] = "oauth-2025-04-20";
  } else {
    headers["x-api-key"] = opts.apiKey;
  }

  // OAuth (Claude Code) tokens require the Claude Code identity as the first
  // system block; a standard API key keeps @keeb/anthropic's plain-string system.
  let system: unknown;
  if (oauth) {
    system = opts.system
      ? [{ type: "text", text: CLAUDE_CODE_IDENTITY }, {
        type: "text",
        text: opts.system,
      }]
      : [{ type: "text", text: CLAUDE_CODE_IDENTITY }];
  } else if (opts.system) {
    system = opts.system;
  }

  const body = {
    model: opts.model,
    max_tokens: opts.maxTokens ?? 2048,
    messages: [{ role: "user", content: userMessage }],
    ...(system !== undefined ? { system } : {}),
  };

  const res = await fetchImpl("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Anthropic API ${res.status}: ${text.slice(0, 400)}`);
  }
  const data = await res.json() as MessagesResponse;
  return (data.content ?? [])
    .filter((b) => b.type === "text")
    .map((b) => b.text ?? "")
    .join("")
    .trim();
}
