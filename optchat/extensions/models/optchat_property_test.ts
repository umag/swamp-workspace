/**
 * Property / invariant / flow suite. Pins the merge order to Taelin's push
 * (the oracle), and checks the view and tree invariants over random chats.
 * Honors `FC_NUM_RUNS` for the nightly soak (`deno task test:soak`).
 */

import fc from "npm:fast-check@4.8.0";
import { assert, assertEquals } from "jsr:@std/assert@1";
import { compact } from "./lib/compactor.ts";
import { systemPrompt } from "./lib/prompts.ts";
import { ChatStore } from "./lib/store.ts";
import { fakeClaude, filler, tempChat } from "./lib/testing.ts";
import {
  bytes,
  coversChat,
  firstOf,
  labelOf,
  lastOf,
  type Line,
  mergeDown,
  NODE_LIMIT,
} from "./lib/tree.ts";

const ENV_RUNS = Deno.env.get("FC_NUM_RUNS");
const NUM_RUNS = ENV_RUNS ? Number(ENV_RUNS) : 25;

// Taelin's push (rollback_state_list.js, 2022) with life fixed at 0.
interface States {
  keep: number;
  state: number;
  older: States | null;
}

function push(newState: number, states: States | null): States {
  if (states === null) return { keep: 0, state: newState, older: null };
  const { keep, state, older } = states;
  if (keep === 0) return { keep: 1, state, older };
  return { keep: 0, state: newState, older: push(state, older) };
}

function starts(states: States | null): number[] {
  const out: number[] = [];
  for (let s = states; s; s = s.older) out.push(s.state);
  return out.reverse();
}

Deno.test("oracle: due-ordered merges equal Taelin's push for t = 0..20000", () => {
  let states: States | null = null;
  let lines: Line[] = [];
  for (let t = 0; t <= 20_000; t++) {
    states = push(t, states);
    const want = starts(states);
    lines.push([0, t]);
    lines = mergeDown(lines, t + 1, want.length, () => 1, () => true).lines;
    assertEquals(lines.map(firstOf), want, `diverged at t=${t}`);
  }
});

Deno.test("oracle: the gist's first-ten-pushes table", () => {
  let states: States | null = null;
  const table: string[] = [];
  for (let t = 0; t < 10; t++) {
    states = push(t, states);
    const parts: string[] = [];
    for (let s: States | null = states; s; s = s.older) {
      parts.push(`${s.keep ? "+" : "-"}${s.state}`);
    }
    table.push(parts.join(", "));
  }
  assertEquals(table[9], "+8, +4, -0");
  assertEquals(table[6], "-6, -4, -0");
});

Deno.test("oracle: measuring from the first message is wrong (T=10 example)", () => {
  const lines: Line[] = [[2, 0], [2, 1], [0, 8], [0, 9]];
  const out = mergeDown(lines, 10, 3, () => 1, () => true).lines;
  assertEquals(out.map(labelOf), ["0+4", "4+4", "8+2"]);
});

Deno.test("property: any budget keeps the view a covering list of tree nodes", () => {
  fc.assert(
    fc.property(
      fc.integer({ min: 1, max: 600 }),
      fc.integer({ min: 2, max: 40 }),
      (T, budget) => {
        let lines: Line[] = [];
        for (let t = 0; t < T; t++) {
          lines.push([0, t]);
          lines = mergeDown(lines, t + 1, budget, () => 1, () => true).lines;
          if (!coversChat(lines, t + 1)) return false;
          for (const [l, i] of lines) if (l < 0 || i < 0) return false;
        }
        // With every parent built, the budget is always reachable once
        // the chat has at least log2(T)+1 lines' worth of room.
        return lines.length <= Math.max(budget, Math.ceil(Math.log2(T + 1)));
      },
    ),
    { numRuns: NUM_RUNS * 4 },
  );
});

Deno.test("flow: random chats keep every store invariant across compactions and reloads", async () => {
  const limits = { high: 1200, low: 600, compactHigh: 500, compactLow: 250 };
  await fc.assert(
    fc.asyncProperty(
      fc.array(
        fc.oneof(
          fc.record({
            op: fc.constant("append" as const),
            size: fc.oneof(
              fc.integer({ min: 1, max: 80 }),
              fc.integer({ min: 500, max: 1500 }),
            ),
            kind: fc.constantFrom("user", "unii", "tool", "echo", "note"),
          }),
          fc.record({ op: fc.constant("compact" as const) }),
          fc.record({ op: fc.constant("reload" as const) }),
        ),
        { minLength: 1, maxLength: 60 },
      ),
      fc.integer({ min: 0, max: 600 }),
      async (ops, reply) => {
        const dir = await tempChat();
        const fake = fakeClaude(() => filler(reply === 0 ? 1 : reply, "s"));
        let s = await ChatStore.open(dir, { lock: true, limits });
        try {
          for (const op of ops) {
            if (op.op === "append") {
              await s.append(op.kind, filler(op.size, "m"));
            } else if (op.op === "compact") {
              await compact(s, {
                factory: fake.factory,
                model: "haiku",
                systemPrompt: systemPrompt("Unii"),
                concurrency: 3,
                timeoutMs: 1000,
              });
            } else {
              const before = JSON.stringify(s.view);
              await s.close();
              s = await ChatStore.open(dir, { lock: true, limits });
              assertEquals(JSON.stringify(s.view), before);
            }
            // The view and the compaction view each cover the whole chat.
            assert(coversChat(s.view.chat, s.T));
            assert(coversChat(s.view.compact, s.T));
            // A line above a leaf is only ever a built node.
            for (const line of [...s.view.chat, ...s.view.compact]) {
              if (line[0] > 0) assert(s.isBuilt(line[0], line[1]));
            }
            // A compaction context never holds an unbuilt line or one
            // starting past the node.
            for (const job of s.readyJobs(8, new Set())) {
              const ctx = s.compactionContext(job);
              assert(!ctx.includes("(not summarized yet"));
              const end = job[0] === 0 ? firstOf(job) - 1 : lastOf(job);
              for (const m of ctx.matchAll(/^(\d+)\+\d+\|/gm)) {
                assert(Number(m[1]) <= end);
              }
            }
          }
          // Every node built from short sources fits the limit; model
          // replies over it were retried (the fake never shortens).
          for (let i = 0; i < s.T; i++) {
            const t = s.nodeText(0, i);
            if (t !== undefined && s.messages[i].size + 8 <= NODE_LIMIT) {
              assert(bytes(t) <= NODE_LIMIT);
            }
          }
        } finally {
          await s.close();
          await Deno.remove(dir, { recursive: true });
        }
      },
    ),
    { numRuns: NUM_RUNS },
  );
});
