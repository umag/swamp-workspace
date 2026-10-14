// =============================================================================
// A conversation with `claude -p` in stream-json mode: one process, several
// user messages, so a "Too long" retry stays in the same conversation. Runs on
// the local Claude Code subscription; no API key. User settings (hooks,
// plugins) and other MCP servers are kept out of every call.
// =============================================================================

/** One event from the stream-json output. */
export type StreamEvent = Record<string, unknown>;

/** What a sent message came back with. */
export interface Reply {
  /** The `result` text of the final event. */
  text: string;
  /** The final `result` event (usage, cost, session id). */
  result: StreamEvent;
}

/** A conversation the caller sends user messages into. */
export interface Session {
  send(text: string, onEvent?: (e: StreamEvent) => void): Promise<Reply>;
  close(): Promise<void>;
}

/** How to start a conversation. */
export interface SessionOptions {
  model: string;
  systemPrompt: string;
  /** Built-in tools; [] disables them all. */
  tools: string[];
  /** Tools allowed without a prompt (built-in names and mcp__server__tool). */
  allowedTools?: string[];
  /** MCP config as a JSON string, or undefined for none. */
  mcpConfig?: string;
  effort?: string;
  cwd?: string;
  /** Per-message timeout. */
  timeoutMs: number;
}

/** Starts conversations; tests inject a fake. */
export type SessionFactory = (opts: SessionOptions) => Session;

/** The argv for one `claude -p` conversation. */
export function claudeArgs(opts: SessionOptions): string[] {
  const args = [
    "-p",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--verbose",
    "--no-session-persistence",
    "--setting-sources",
    "",
    "--strict-mcp-config",
    "--model",
    opts.model,
    "--system-prompt",
    opts.systemPrompt,
    "--tools",
    opts.tools.join(","),
  ];
  if (opts.allowedTools?.length) {
    args.push("--allowedTools", opts.allowedTools.join(","));
  }
  if (opts.mcpConfig) args.push("--mcp-config", opts.mcpConfig);
  if (opts.effort) args.push("--effort", opts.effort);
  return args;
}

/** A SessionFactory that runs the `claude` binary at `bin`. */
export function claudeCli(bin = "claude"): SessionFactory {
  return (opts) => new CliSession(bin, opts);
}

class CliSession implements Session {
  private readonly child: Deno.ChildProcess;
  private readonly writer: WritableStreamDefaultWriter<Uint8Array>;
  private waiting: {
    resolve: (r: Reply) => void;
    reject: (e: Error) => void;
    onEvent?: (e: StreamEvent) => void;
  } | null = null;
  private stderr = "";
  private exited = false;
  private readonly done: Promise<void>;

  constructor(bin: string, private readonly opts: SessionOptions) {
    this.child = new Deno.Command(bin, {
      args: claudeArgs(opts),
      cwd: opts.cwd,
      stdin: "piped",
      stdout: "piped",
      stderr: "piped",
    }).spawn();
    this.writer = this.child.stdin.getWriter();
    this.done = Promise.all([this.readOut(), this.readErr()]).then(
      async () => {
        await this.child.status;
        this.exited = true;
        this.fail(
          new Error(
            `claude exited before replying: ${this.stderr.slice(-800)}`,
          ),
        );
      },
    );
  }

  private fail(err: Error): void {
    const w = this.waiting;
    this.waiting = null;
    w?.reject(err);
  }

  private async readOut(): Promise<void> {
    const decoder = new TextDecoderStream();
    const reader = this.child.stdout.pipeThrough(decoder).getReader();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += value;
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (line) this.onLine(line);
      }
    }
  }

  private async readErr(): Promise<void> {
    const reader = this.child.stderr.pipeThrough(new TextDecoderStream())
      .getReader();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      this.stderr = (this.stderr + value).slice(-4000);
    }
  }

  private onLine(line: string): void {
    let event: StreamEvent;
    try {
      event = JSON.parse(line);
    } catch {
      return;
    }
    const w = this.waiting;
    if (!w) return;
    w.onEvent?.(event);
    if (event.type === "result") {
      this.waiting = null;
      if (event.is_error) {
        w.reject(
          new Error(
            `claude returned an error: ${JSON.stringify(event.result)}`,
          ),
        );
      } else {
        w.resolve({ text: String(event.result ?? ""), result: event });
      }
    }
  }

  async send(text: string, onEvent?: (e: StreamEvent) => void): Promise<Reply> {
    if (this.exited) throw new Error("claude session already exited");
    if (this.waiting) throw new Error("a message is already in flight");
    const reply = new Promise<Reply>((resolve, reject) => {
      this.waiting = { resolve, reject, onEvent };
    });
    const msg = {
      type: "user",
      message: { role: "user", content: text },
    };
    await this.writer.write(
      new TextEncoder().encode(JSON.stringify(msg) + "\n"),
    );
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () =>
          reject(new Error(`claude timed out after ${this.opts.timeoutMs} ms`)),
        this.opts.timeoutMs,
      );
    });
    try {
      return await Promise.race([reply, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  async close(): Promise<void> {
    try {
      await this.writer.close();
    } catch {
      // already closed
    }
    const kill = setTimeout(() => {
      try {
        this.child.kill("SIGTERM");
      } catch {
        // already gone
      }
    }, 10_000);
    await this.done.catch(() => {});
    clearTimeout(kill);
  }
}
