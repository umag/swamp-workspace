// =============================================================================
// The chat directory: an append-only log of messages and tree nodes, plus the
// saved view. One process owns a chat at a time (a lock file); readers such as
// the MCP zoom server read the files without the lock.
//
//   main/YYYY-MM-DD.jsonl  messages {i, kind, text, size, date}
//   tree/YYYY-MM-DD.jsonl  nodes {l, i, text, size}
//   view.json              {T, chat, compact, merging} — lines as [l, i]
// =============================================================================

import {
  bytes,
  coversChat,
  firstOf,
  keyOf,
  lastOf,
  leafSource,
  type Line,
  lineCost,
  lineOf,
  mergeDown,
  type Message,
  NODE_LIMIT,
  renderLine,
  type TreeNode,
} from "./tree.ts";

/** Sizes of the chat view and the compaction view, in bytes. */
export interface ViewLimits {
  /** A batch merge starts once the chat view passes this. */
  high: number;
  /** A batch merges the chat view down to this. */
  low: number;
  /** The compaction view is merged again once it passes this. */
  compactHigh: number;
  /** The compaction view is merged down to this. */
  compactLow: number;
}

/** The gist's sizes: chat view 64-128 KB, compaction view 16-32 KB. */
export const DEFAULT_LIMITS: ViewLimits = {
  high: 128_000,
  low: 64_000,
  compactHigh: 32_000,
  compactLow: 16_000,
};

/** Longest text one message holds; longer text spans several messages. */
export const MAX_MESSAGE_CHARS = 30_000;

/** Saved view state. */
export interface ViewState {
  T: number;
  chat: Line[];
  compact: Line[];
  merging: boolean;
}

/** A node the compactor can build now: a leaf, or a merge of two built lines. */
export interface Job {
  line: Line;
}

/** Options for opening a chat directory. */
export interface OpenOptions {
  /** Take the write lock (every method that appends). */
  lock?: boolean;
  /** Steal a lock older than this many minutes. */
  lockStaleMinutes?: number;
  limits?: ViewLimits;
  /** Load messages and nodes only: no directories made, no view, no queues. */
  readOnly?: boolean;
}

function dayOf(date: string): string {
  return date.slice(0, 10);
}

async function readJsonl<T>(dir: string): Promise<T[]> {
  const names: string[] = [];
  try {
    for await (const e of Deno.readDir(dir)) {
      if (e.isFile && e.name.endsWith(".jsonl")) names.push(e.name);
    }
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return [];
    throw err;
  }
  names.sort();
  const out: T[] = [];
  for (const name of names) {
    const text = await Deno.readTextFile(`${dir}/${name}`);
    for (const line of text.split("\n")) {
      // A torn last line (crash mid-write) is skipped, never repaired.
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line) as T);
      } catch {
        // skip
      }
    }
  }
  return out;
}

async function appendLine(path: string, value: unknown): Promise<void> {
  const file = await Deno.open(path, {
    append: true,
    create: true,
    write: true,
  });
  try {
    const data = new TextEncoder().encode(JSON.stringify(value) + "\n");
    let written = 0;
    while (written < data.length) {
      written += await file.write(data.subarray(written));
    }
    await file.syncData();
  } finally {
    file.close();
  }
}

/** Split text into chunks of at most `max` characters (code points). */
export function splitText(text: string, max = MAX_MESSAGE_CHARS): string[] {
  const chars = Array.from(text);
  if (chars.length <= max) return [text];
  const out: string[] = [];
  for (let k = 0; k < chars.length; k += max) {
    out.push(chars.slice(k, k + max).join(""));
  }
  return out;
}

/** Clip a tool result to its head and tail, `max` characters in all. */
export function clipText(text: string, max = MAX_MESSAGE_CHARS): string {
  const chars = Array.from(text);
  if (chars.length <= max) return text;
  const head = Math.ceil(max / 2);
  const tail = max - head;
  const cut = chars.length - max;
  return chars.slice(0, head).join("") +
    `\n…[${cut} characters clipped]…\n` +
    chars.slice(chars.length - tail).join("");
}

/** An open chat directory with the whole log loaded in memory. */
export class ChatStore {
  readonly messages: Message[] = [];
  private readonly nodes = new Map<string, TreeNode>();
  view: ViewState = { T: 0, chat: [], compact: [], merging: false };
  /** Unbuilt leaves, ascending. */
  private readonly leafQueue: number[] = [];
  /** Merges whose two halves are built, by key. */
  private readonly mergeQueue = new Map<string, Line>();
  private locked = false;

  private constructor(
    readonly dir: string,
    readonly limits: ViewLimits,
  ) {}

  /** Open (creating if needed) a chat directory and load it. */
  static async open(dir: string, opts: OpenOptions = {}): Promise<ChatStore> {
    const store = new ChatStore(dir, opts.limits ?? DEFAULT_LIMITS);
    if (opts.readOnly) {
      await store.loadLog();
      return store;
    }
    await Deno.mkdir(`${dir}/main`, { recursive: true });
    await Deno.mkdir(`${dir}/tree`, { recursive: true });
    if (opts.lock) await store.acquire(opts.lockStaleMinutes ?? 60);
    try {
      await store.load();
    } catch (err) {
      await store.close();
      throw err;
    }
    return store;
  }

  private async acquire(staleMinutes: number): Promise<void> {
    const path = `${this.dir}/.lock`;
    const body = JSON.stringify({
      pid: Deno.pid,
      host: Deno.hostname(),
      at: new Date().toISOString(),
    });
    try {
      await Deno.writeTextFile(path, body, { createNew: true });
    } catch (err) {
      if (!(err instanceof Deno.errors.AlreadyExists)) throw err;
      const info = await Deno.stat(path);
      const age = Date.now() - (info.mtime?.getTime() ?? 0);
      if (age < staleMinutes * 60_000) {
        const holder = await Deno.readTextFile(path).catch(() => "?");
        throw new Error(
          `chat ${this.dir} is locked by ${holder}; it is stale after ` +
            `${staleMinutes} min, or delete ${path} if no process holds it`,
        );
      }
      await Deno.writeTextFile(path, body);
    }
    this.locked = true;
  }

  /** Release the lock, if held. */
  async close(): Promise<void> {
    if (!this.locked) return;
    this.locked = false;
    await Deno.remove(`${this.dir}/.lock`).catch(() => {});
  }

  private async loadLog(): Promise<void> {
    const msgs = await readJsonl<Message>(`${this.dir}/main`);
    msgs.sort((a, b) => a.i - b.i);
    for (const m of msgs) {
      if (m.i !== this.messages.length) {
        if (m.i < this.messages.length) continue; // duplicate id: first wins
        throw new Error(
          `message log has a gap: expected id ${this.messages.length}, found ${m.i}`,
        );
      }
      this.messages.push(m);
    }
    for (const n of await readJsonl<TreeNode>(`${this.dir}/tree`)) {
      const key = keyOf(n.l, n.i);
      if (!this.nodes.has(key)) this.nodes.set(key, n);
    }
  }

  private async load(): Promise<void> {
    await this.loadLog();
    const T = this.messages.length;
    try {
      const saved = JSON.parse(
        await Deno.readTextFile(`${this.dir}/view.json`),
      ) as ViewState;
      this.view = saved;
    } catch (err) {
      if (!(err instanceof Deno.errors.NotFound)) throw err;
    }
    // The view is saved after its message is logged, so after a crash it can
    // trail the log. Append the missing lines; never rebuild it.
    if (this.view.T > T || !coversChat(this.view.chat, this.view.T)) {
      throw new Error(
        `view.json covers ${this.view.T} messages but the log holds ${T}`,
      );
    }
    for (let i = this.view.T; i < T; i++) {
      this.view.chat.push([0, i]);
      this.view.compact.push([0, i]);
    }
    this.view.T = T;
    // Rebuild the work queues in one pass over the tree.
    for (let i = 0; i < T; i++) {
      if (!this.isBuilt(0, i)) this.leafQueue.push(i);
    }
    for (const n of this.nodes.values()) {
      if (n.i % 2 === 0 && this.isBuilt(n.l, n.i + 1)) {
        this.queueParent(n.l, n.i);
      }
    }
  }

  /** Number of messages. */
  get T(): number {
    return this.messages.length;
  }

  /** Whether node (l, i) is built. */
  isBuilt(l: number, i: number): boolean {
    return this.nodes.has(keyOf(l, i));
  }

  /** Text of node (l, i), or undefined when unbuilt. */
  nodeText(l: number, i: number): string | undefined {
    return this.nodes.get(keyOf(l, i))?.text;
  }

  /** Number of built nodes. */
  get nodeCount(): number {
    return this.nodes.size;
  }

  private cost = (line: Line): number =>
    lineCost(line, this.nodeText(line[0], line[1]));

  private built = (l: number, i: number): boolean => this.isBuilt(l, i);

  /** Byte size of a view, as rendered. */
  viewBytes(lines: Line[] = this.view.chat): number {
    let total = 0;
    for (const line of lines) total += this.cost(line);
    return total;
  }

  /** The view as the model sees it, inside <chat> tags. */
  renderView(lines: Line[] = this.view.chat): string {
    const body = lines.map((line) =>
      renderLine(line, this.nodeText(line[0], line[1]))
    );
    return `<chat>\n${body.join("\n")}${body.length ? "\n" : ""}</chat>`;
  }

  /**
   * Log text as one or more messages of a kind (tool results are clipped,
   * other long text spans several messages). Short messages become their own
   * leaf node at once; the view grows by one line per message.
   */
  async append(kind: string, text: string, date = new Date()): Promise<
    Message[]
  > {
    if (!this.locked) throw new Error("append needs the chat lock");
    const chunks = kind === "echo" ? [clipText(text)] : splitText(text);
    const out: Message[] = [];
    for (const chunk of chunks) {
      const iso = date.toISOString();
      const m: Message = {
        i: this.messages.length,
        kind,
        text: chunk,
        size: bytes(chunk),
        date: iso,
      };
      await appendLine(`${this.dir}/main/${dayOf(iso)}.jsonl`, m);
      this.messages.push(m);
      out.push(m);
      const source = leafSource(m);
      if (bytes(source) <= NODE_LIMIT) {
        await this.putNode([0, m.i], source);
      } else {
        this.leafQueue.push(m.i);
      }
      this.view.chat.push([0, m.i]);
      this.view.compact.push([0, m.i]);
      this.view.T = this.messages.length;
      this.rebalance();
      await this.saveView();
    }
    return out;
  }

  /**
   * The gist's "when": merge the chat view in one batch from `high` down to
   * `low`, continuing at each message while it cannot get there yet. The
   * compaction view is re-derived after a chat batch, or merged on its own
   * once it passes `compactHigh`.
   */
  private rebalance(): void {
    const T = this.view.T;
    const { high, low, compactHigh, compactLow } = this.limits;
    if (this.view.merging || this.viewBytes() > high) {
      const r = mergeDown(this.view.chat, T, low, this.cost, this.built);
      this.view.merging = r.total > low;
      if (r.merges > 0) {
        this.view.chat = r.lines;
        this.view.compact = mergeDown(
          r.lines,
          T,
          compactLow,
          this.cost,
          this.built,
        ).lines;
        return;
      }
    }
    if (this.viewBytes(this.view.compact) > compactHigh) {
      this.view.compact = mergeDown(
        this.view.compact,
        T,
        compactLow,
        this.cost,
        this.built,
      ).lines;
    }
  }

  private async saveView(): Promise<void> {
    const tmp = `${this.dir}/view.json.tmp`;
    await Deno.writeTextFile(tmp, JSON.stringify(this.view));
    await Deno.rename(tmp, `${this.dir}/view.json`);
  }

  /**
   * Log a built node. Its parent becomes ready once its sibling is built; a
   * parent whose two halves fit in NODE_LIMIT joined is built at once.
   */
  async putNode(line: Line, text: string): Promise<void> {
    if (!this.locked) throw new Error("putNode needs the chat lock");
    const [l, i] = line;
    const key = keyOf(l, i);
    if (this.nodes.has(key)) return; // built once, never again
    const node: TreeNode = { l, i, text, size: bytes(text) };
    const date = new Date().toISOString();
    await appendLine(`${this.dir}/tree/${dayOf(date)}.jsonl`, node);
    this.nodes.set(key, node);
    this.mergeQueue.delete(key);
    if (l === 0) {
      const k = this.leafQueue.indexOf(i);
      if (k >= 0) this.leafQueue.splice(k, 1);
    }
    const first = i - (i % 2);
    if (this.isBuilt(l, first) && this.isBuilt(l, first + 1)) {
      const joined = `${this.nodeText(l, first)}\n${
        this.nodeText(l, first + 1)
      }`;
      if (bytes(joined) <= NODE_LIMIT) {
        await this.putNode([l + 1, first / 2], joined);
      } else {
        this.queueParent(l, first);
      }
    }
  }

  private queueParent(l: number, firstSibling: number): void {
    const parent: Line = [l + 1, firstSibling / 2];
    const key = keyOf(parent[0], parent[1]);
    if (!this.nodes.has(key)) this.mergeQueue.set(key, parent);
  }

  /**
   * Nodes ready to build: every merge whose halves are built, then the first
   * `window` unbuilt leaves (a leaf starts once fewer than `window` lines
   * before it are unbuilt). Excludes keys in `skip` (running or failed).
   */
  readyJobs(window: number, skip: Set<string>): Line[] {
    const out: Line[] = [];
    for (const [key, line] of this.mergeQueue) {
      if (!skip.has(key)) out.push(line);
    }
    for (const i of this.leafQueue.slice(0, window)) {
      if (!skip.has(keyOf(0, i))) out.push([0, i]);
    }
    return out;
  }

  /**
   * The text of a node that needs no model call: a leaf whose message fits,
   * or a merge whose halves fit joined by a newline. Undefined otherwise.
   */
  trivialText(line: Line): string | undefined {
    const [l, i] = line;
    if (l === 0) {
      const source = leafSource(this.messages[i]);
      return bytes(source) <= NODE_LIMIT ? source : undefined;
    }
    const a = this.nodeText(l - 1, 2 * i);
    const b = this.nodeText(l - 1, 2 * i + 1);
    if (a === undefined || b === undefined) return undefined;
    const joined = `${a}\n${b}`;
    return bytes(joined) <= NODE_LIMIT ? joined : undefined;
  }

  /** Number of unbuilt leaves plus ready merges. */
  get pending(): number {
    return this.leafQueue.length + this.mergeQueue.size;
  }

  /** Whether every message has its leaf node. */
  get leavesBuilt(): boolean {
    return this.leafQueue.length === 0;
  }

  /**
   * The context a compaction of `line` sees: the compaction view's lines up
   * to the node — before the message for a leaf, up to the merge's last
   * message for a merge — stopping at the first unbuilt line.
   */
  compactionContext(line: Line): string {
    const end = line[0] === 0 ? firstOf(line) - 1 : lastOf(line);
    const lines: Line[] = [];
    for (const l of this.view.compact) {
      if (firstOf(l) > end || !this.isBuilt(l[0], l[1])) break;
      lines.push(l);
    }
    return this.renderView(lines);
  }

  /** zoom(id, n): the two lines under id+n, or message id whole when n = 1. */
  zoom(id: number, n: number): string {
    const line = lineOf(id, n);
    if (lastOf(line) >= this.T) {
      throw new Error(
        `${id}+${n} reaches past the last message (${this.T - 1})`,
      );
    }
    if (n === 1) {
      const m = this.messages[id];
      return `${m.kind}: ${m.text}`;
    }
    const [l, i] = line;
    const kids: Line[] = [[l - 1, 2 * i], [l - 1, 2 * i + 1]];
    return kids.map((k) => renderLine(k, this.nodeText(k[0], k[1]))).join(
      "\n",
    );
  }

  /** date(id): when message id was logged. */
  date(id: number): string {
    const m = this.messages[id];
    if (!m) throw new Error(`no message ${id} (chat has ${this.T})`);
    return m.date;
  }
}
