/**
 * Property-invariant-flow suite for @magistr/telegram-import (fast-check).
 *
 * telegram_import.ts is UNMODIFIED — every property observes already-shipped
 * behavior by driving `model.methods.import.execute()` against the shared
 * stub seam (telegram_import_test_helpers.ts) over arbitrary well-formed
 * message arrays. Runs under `@std/testing`'s FakeTime so every generated
 * case gets the SAME `new Date().toISOString()` timestamp, keeping
 * comparisons (including the idempotency property) deterministic.
 *
 * Arbitraries are restricted to WELL-FORMED shapes (numeric ids, ISO date
 * strings, ASCII text) — the traversal/injection-shaped inputs that break
 * these invariants on purpose are pinned separately, as characterization,
 * in telegram_import_adversarial_test.ts (LB-1/LB-2/LB-3).
 *
 * Properties:
 *  (a) message-count — totalMessages/notesCreated/post-count all equal the
 *      number of `message`-type entries when nothing is configured to fail.
 *  (b) id preservation — every written post's `id` matches its source
 *      message's `id`.
 *  (c) 500-char truncation — post.text.length is always <= 500, and equals
 *      the original text when the original is <= 500 chars.
 *  (d) slug format — the obsidian create `path=` argument always matches
 *      `<folder>/<dateOnlyPart>-<id>` for numeric ids and simple ISO dates.
 *  (e) re-import idempotency — running import twice over the SAME input
 *      (fresh ctx + fresh stubs each time) yields an identical summary and
 *      an identical set of post payloads.
 *  (f) vaultRoot import invariant (swamp-workspace #57) — for any synthetic
 *      set of messages with unique ids, importing via the headless vaultRoot
 *      global argument writes exactly one note per message, each note's
 *      frontmatter parse recovers the keys this model wrote, and no
 *      produced note path escapes the vault's REAL (symlink-resolved) root.
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import { FakeTime } from "jsr:@std/testing@1/time";
import fc from "npm:fast-check@4.8.0";
import {
  DEFAULT_GLOBAL_ARGS,
  makeCtx,
  runImport,
  withStubs,
  writeRealResultJson,
} from "./telegram_import_test_helpers.ts";

// Property iteration count — overridable for a nightly soak via FC_NUM_RUNS
// (e.g. FC_NUM_RUNS=10000 deno task test:soak).
const ENV_RUNS = Deno.env.get("FC_NUM_RUNS");
const NIGHT = (n: number): number => (ENV_RUNS ? Number(ENV_RUNS) : n);
const FC_RUNS = { numRuns: NIGHT(100) };

const isoDate = fc
  .date({
    min: new Date("2015-01-01T00:00:00Z"),
    max: new Date("2030-01-01T00:00:00Z"),
    noInvalidDate: true,
  })
  .map((d) => d.toISOString());

const messageArb = fc.record({
  id: fc.integer({ min: 1, max: 999_999 }),
  date: isoDate,
  text: fc.string({ maxLength: 300, unit: "grapheme-ascii" }),
});

async function runOverMessages(
  messages: { id: number; date: string; text: string }[],
) {
  const real = await writeRealResultJson({
    name: "Fixture Property Channel",
    type: "public_channel",
    id: 1,
    messages: messages.map((m) => ({ ...m, type: "message" })),
  });
  try {
    const { ctx, written } = makeCtx();
    let calls: { path?: string }[] = [];
    await withStubs({ resultJsonPath: real.resultPath }, async (stubs) => {
      await runImport(ctx);
      calls = stubs.obsidianCreateCalls;
    });
    return { written, calls };
  } finally {
    await real.cleanup();
  }
}

// ---------------------------------------------------------------------------
// (a) message-count invariant
// ---------------------------------------------------------------------------

Deno.test("property: totalMessages/notesCreated/post-count all equal the input message count", async () => {
  const time = new FakeTime(new Date("2024-06-01T00:00:00.000Z"));
  try {
    await fc.assert(
      fc.asyncProperty(
        fc.array(messageArb, { maxLength: 15 }),
        async (messages) => {
          const { written } = await runOverMessages(messages);
          const result = written.find((w) => w.spec === "result")!;
          assertEquals(result.payload.totalMessages, messages.length);
          assertEquals(result.payload.notesCreated, messages.length);
          assertEquals(result.payload.errors, []);
          assertEquals(
            written.filter((w) => w.spec === "post").length,
            messages.length,
          );
        },
      ),
      FC_RUNS,
    );
  } finally {
    time.restore();
  }
});

// ---------------------------------------------------------------------------
// (b) id preservation
// ---------------------------------------------------------------------------

Deno.test("property: every written post's id matches its source message's id", async () => {
  const time = new FakeTime(new Date("2024-06-01T00:00:00.000Z"));
  try {
    await fc.assert(
      fc.asyncProperty(
        fc.array(messageArb, { minLength: 1, maxLength: 10 }),
        async (messages) => {
          const { written } = await runOverMessages(messages);
          const posts = written.filter((w) => w.spec === "post");
          const gotIds = posts.map((p) => p.payload.id).sort((a, b) =>
            (a as number) - (b as number)
          );
          const wantIds = messages.map((m) => m.id).sort((a, b) => a - b);
          assertEquals(gotIds, wantIds);
        },
      ),
      FC_RUNS,
    );
  } finally {
    time.restore();
  }
});

// ---------------------------------------------------------------------------
// (c) 500-char truncation invariant
// ---------------------------------------------------------------------------

Deno.test("property: post.text.length is always <= 500, and equals the original when the original is <= 500 chars", async () => {
  const time = new FakeTime(new Date("2024-06-01T00:00:00.000Z"));
  try {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 999_999 }),
        isoDate,
        fc.string({ maxLength: 800, unit: "grapheme-ascii" }),
        async (id, date, text) => {
          const { written } = await runOverMessages([{ id, date, text }]);
          const post = written.find((w) => w.spec === "post")!;
          const gotText = post.payload.text as string;
          assert(gotText.length <= 500);
          if (text.length <= 500) {
            assertEquals(gotText, text);
          } else {
            assertEquals(gotText, text.substring(0, 500));
          }
        },
      ),
      FC_RUNS,
    );
  } finally {
    time.restore();
  }
});

// ---------------------------------------------------------------------------
// (d) slug-format invariant
// ---------------------------------------------------------------------------

Deno.test("property: obsidian create path= always matches Telegram/<dateOnly>-<id> for numeric ids + ISO dates", async () => {
  const time = new FakeTime(new Date("2024-06-01T00:00:00.000Z"));
  try {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 999_999 }),
        isoDate,
        fc.string({ maxLength: 50, unit: "grapheme-ascii" }),
        async (id, date, text) => {
          const { calls } = await runOverMessages([{ id, date, text }]);
          assertEquals(calls.length, 1);
          const dateOnly = date.split("T")[0];
          assertEquals(calls[0].path, `Telegram/${dateOnly}-${id}`);
        },
      ),
      FC_RUNS,
    );
  } finally {
    time.restore();
  }
});

// ---------------------------------------------------------------------------
// (e) re-import idempotency
// ---------------------------------------------------------------------------

Deno.test("property: re-running import over the SAME input twice yields an identical summary and identical posts", async () => {
  const time = new FakeTime(new Date("2024-06-01T00:00:00.000Z"));
  try {
    await fc.assert(
      fc.asyncProperty(
        fc.array(messageArb, { maxLength: 8 }),
        async (messages) => {
          const first = await runOverMessages(messages);
          const second = await runOverMessages(messages);
          const firstResult = first.written.find((w) => w.spec === "result")!;
          const secondResult = second.written.find((w) => w.spec === "result")!;
          assertEquals(firstResult.payload, secondResult.payload);
          const firstPosts = first.written.filter((w) => w.spec === "post");
          const secondPosts = second.written.filter((w) => w.spec === "post");
          assertEquals(firstPosts, secondPosts);
        },
      ),
      FC_RUNS,
    );
  } finally {
    time.restore();
  }
});

// ---------------------------------------------------------------------------
// (f) vaultRoot import invariant (swamp-workspace #57): exactly one note per
// importable item, frontmatter round-trips its keys, no path escapes the
// vault's REAL root
// ---------------------------------------------------------------------------

const uniqueMessageArrayArb = fc.uniqueArray(messageArb, {
  selector: (m) => m.id,
  minLength: 1,
  maxLength: 8,
});

/**
 * Minimal reader for this model's hand-built frontmatter block -- recovers
 * scalar `key: value` lines and the `tags:` block-style list. Good enough to
 * assert round-trip of the KEYS this model writes; not a general YAML parser
 * (this model deliberately does not depend on one -- see the plan's scope
 * constraint: no npm:yaml, PATH-CONFINEMENT only transfers from PR #56).
 */
function parseSimpleFrontmatter(note: string): Record<string, unknown> {
  const lines = note.split("\n");
  if (lines[0] !== "---") return {};
  const props: Record<string, unknown> = {};
  let i = 1;
  for (; i < lines.length; i++) {
    const line = lines[i];
    if (line === "---") break;
    if (line === "tags:") {
      const tags: string[] = [];
      let j = i + 1;
      while (j < lines.length && lines[j].startsWith("  - ")) {
        tags.push(lines[j].slice(4));
        j++;
      }
      props.tags = tags;
      i = j - 1;
      continue;
    }
    const m = line.match(/^([a-zA-Z_]+): (.*)$/);
    if (m) {
      const [, key, rawValue] = m;
      props[key] = rawValue.startsWith('"') && rawValue.endsWith('"')
        ? rawValue.slice(1, -1)
        : rawValue;
    }
  }
  return props;
}

Deno.test("property: importing via vaultRoot writes exactly one note per message, each note's frontmatter round-trips its keys, and no note path escapes the vault's REAL root", async () => {
  const time = new FakeTime(new Date("2024-06-01T00:00:00.000Z"));
  try {
    await fc.assert(
      fc.asyncProperty(uniqueMessageArrayArb, async (messages) => {
        const real = await writeRealResultJson({
          name: "Fixture Property Channel",
          type: "public_channel",
          id: 1,
          messages: messages.map((m) => ({ ...m, type: "message" })),
        });
        const vaultRoot = await Deno.makeTempDir({
          prefix: "telegram-import-property-vaultroot-",
        });
        try {
          const realRoot = await Deno.realPath(vaultRoot);
          const { ctx, written } = makeCtx({
            ...DEFAULT_GLOBAL_ARGS,
            vaultRoot,
          });
          await withStubs(
            { resultJsonPath: real.resultPath, realMkdir: true },
            async () => {
              await runImport(ctx);
            },
          );
          const result = written.find((w) => w.spec === "result")!;
          if (result.payload.notesCreated !== messages.length) return false;
          if ((result.payload.errors as string[]).length !== 0) return false;

          for (const m of messages) {
            const slug = `${m.date.split("T")[0]}-${m.id}`;
            const fullPath = `${vaultRoot}/Telegram/${slug}.md`;
            const realNotePath = await Deno.realPath(fullPath);
            if (!realNotePath.startsWith(`${realRoot}/`)) return false; // containment
            const note = await Deno.readTextFile(fullPath);
            const props = parseSimpleFrontmatter(note);
            if (props.source !== "telegram") return false;
            if (String(props.telegram_id) !== String(m.id)) return false;
            if (!Array.isArray(props.tags)) return false;
            if (!(props.tags as string[]).includes("telegram")) return false;
          }
          return true;
        } finally {
          await real.cleanup();
          await Deno.remove(vaultRoot, { recursive: true });
        }
      }),
      FC_RUNS,
    );
  } finally {
    time.restore();
  }
});
