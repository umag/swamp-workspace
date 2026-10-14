// =============================================================================
// Compactions: build every ready tree node, up to `concurrency` at once. Each
// call gets the same system prompt as turns, the compaction view up to the
// node, and the task. A line over 512 bytes gets a "Too long" follow-up in the
// same conversation, up to `attempts` tries; the shortest line is kept. A
// failed node stays unbuilt and is tried again on the next run.
// =============================================================================

import type { Session, SessionFactory } from "./llm.ts";
import {
  cleanLine,
  compressTask,
  headBytes,
  mergeTask,
  tooLongTask,
} from "./prompts.ts";
import type { ChatStore } from "./store.ts";
import {
  bytes,
  firstOf,
  keyOf,
  labelOf,
  lastOf,
  type Line,
  NODE_LIMIT,
  renderLine,
} from "./tree.ts";

/** How compactions run. */
export interface CompactOptions {
  factory: SessionFactory;
  model: string;
  effort?: string;
  systemPrompt: string;
  concurrency: number;
  timeoutMs: number;
  /** Tries per node, the first included. */
  attempts?: number;
  /** Stop starting model calls after this many. */
  maxCalls?: number;
  /** Stop once every leaf is built (a turn waits only for that). */
  untilLeavesBuilt?: boolean;
}

/** What a compaction run did. */
export interface CompactResult {
  built: number;
  calls: number;
  failed: { node: string; error: string }[];
  pending: number;
}

/** The task text for one node. */
export function taskFor(store: ChatStore, line: Line): string {
  const [l, i] = line;
  if (l === 0) {
    const m = store.messages[i];
    return compressTask(i, m.kind, m.text);
  }
  const a: Line = [l - 1, 2 * i];
  const b: Line = [l - 1, 2 * i + 1];
  return mergeTask(
    labelOf(a),
    labelOf(b),
    firstOf(line),
    lastOf(line),
    renderLine(a, store.nodeText(a[0], a[1])),
    renderLine(b, store.nodeText(b[0], b[1])),
  );
}

/** Ask the model for one node's line, retrying while it is too long. */
export async function writeLine(
  session: Session,
  prompt: string,
  attempts: number,
): Promise<string> {
  let reply = cleanLine((await session.send(prompt)).text);
  if (!reply) throw new Error("empty compaction reply");
  let best = reply;
  for (let k = 1; k < attempts && bytes(reply) > NODE_LIMIT; k++) {
    const next = cleanLine(
      (await session.send(
        tooLongTask(bytes(reply), headBytes(reply, NODE_LIMIT)),
      )).text,
    );
    if (!next) break;
    reply = next;
    if (bytes(reply) < bytes(best)) best = reply;
  }
  return best;
}

/** Build every ready node (or stop early per the options). */
export async function compact(
  store: ChatStore,
  opts: CompactOptions,
): Promise<CompactResult> {
  const attempts = opts.attempts ?? 5;
  const running = new Map<string, Promise<void>>();
  const failedKeys = new Set<string>();
  const result: CompactResult = { built: 0, calls: 0, failed: [], pending: 0 };

  const start = (line: Line, key: string): void => {
    const trivial = store.trivialText(line);
    const job = trivial !== undefined
      ? store.putNode(line, trivial)
      : (async () => {
        result.calls++;
        const session = opts.factory({
          model: opts.model,
          effort: opts.effort,
          systemPrompt: opts.systemPrompt,
          tools: [],
          timeoutMs: opts.timeoutMs,
        });
        try {
          const prompt = `${store.compactionContext(line)}\n\n${
            taskFor(store, line)
          }`;
          const text = await writeLine(session, prompt, attempts);
          await store.putNode(line, text);
        } finally {
          await session.close();
        }
      })();
    running.set(
      key,
      job.then(
        () => {
          result.built++;
        },
        (err) => {
          failedKeys.add(key);
          result.failed.push({
            node: labelOf(line),
            error: err instanceof Error ? err.message : String(err),
          });
        },
      ).finally(() => {
        running.delete(key);
      }),
    );
  };

  for (;;) {
    if (opts.untilLeavesBuilt && store.leavesBuilt) break;
    const skip = new Set([...running.keys(), ...failedKeys]);
    for (const line of store.readyJobs(opts.concurrency, skip)) {
      if (running.size >= opts.concurrency) break;
      const key = keyOf(line[0], line[1]);
      const needsCall = store.trivialText(line) === undefined;
      if (
        needsCall && opts.maxCalls !== undefined &&
        result.calls >= opts.maxCalls
      ) continue;
      start(line, key);
    }
    if (running.size === 0) break;
    await Promise.race(running.values());
  }
  await Promise.all(running.values());
  result.pending = store.pending;
  return result;
}
