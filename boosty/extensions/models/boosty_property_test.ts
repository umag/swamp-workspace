/**
 * Property suite for @magistr/boosty (fast-check, FC_NUM_RUNS knob).
 *
 *  (a) safeName never yields a path separator, a forbidden char, or "".
 *  (b) normalizeToken is idempotent and never throws.
 *  (c) renderBlocks never throws on arbitrary block lists.
 *  (d) archive flow — for any page layout, every post gets exactly one note.
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import fc from "npm:fast-check@4.8.0";
import { model, normalizeToken, renderBlocks, safeName } from "./boosty.ts";
import {
  boostyRoute,
  listDir,
  makeCtx,
  post,
  tempDir,
  withFetch,
} from "./boosty_harness_test.ts";

const numRuns = Number(Deno.env.get("FC_NUM_RUNS") ?? "100");

Deno.test("property: safeName output is a single safe path segment", () => {
  fc.assert(
    fc.property(fc.string(), (s) => {
      const n = safeName(s);
      assert(n.length > 0 && n.length <= 120);
      assert(!/[\\/:*?"<>|#^[\]]/.test(n));
      assert(n !== "." && n !== "..");
    }),
    { numRuns },
  );
});

Deno.test("property: normalizeToken is idempotent", () => {
  fc.assert(
    fc.property(fc.string(), (s) => {
      const once = normalizeToken(s);
      assertEquals(normalizeToken(once), once);
    }),
    { numRuns },
  );
});

Deno.test("property: renderBlocks never throws", () => {
  const block = fc.record({
    type: fc.constantFrom("text", "link", "image", "video", "file", "x"),
    content: fc.option(fc.string(), { nil: undefined }),
    modificator: fc.option(fc.constantFrom("", "BLOCK_END"), {
      nil: undefined,
    }),
    url: fc.option(fc.webUrl(), { nil: undefined }),
    title: fc.option(fc.string(), { nil: undefined }),
  });
  fc.assert(
    fc.property(fc.array(block, { maxLength: 30 }), (blocks) => {
      renderBlocks(blocks, () => "a.png", "u");
    }),
    { numRuns },
  );
});

Deno.test("property: archive writes exactly one note per post across any paging", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.array(fc.integer({ min: 0, max: 4 }), { minLength: 1, maxLength: 4 }),
      async (sizes) => {
        let n = 0;
        const pages = sizes.map((k) =>
          Array.from({ length: k }, () => {
            n++;
            return post(`${String(n).padStart(8, "0")}-id`, "Same title");
          })
        );
        const dir = await tempDir();
        try {
          const { ctx, written } = makeCtx();
          await withFetch(
            boostyRoute(pages),
            () =>
              model.methods.archive.execute({ blog: "b", outputDir: dir }, ctx),
          );
          const notes = (await listDir(dir)).filter((f) => f.endsWith(".md"));
          assertEquals(notes.length, n);
          assertEquals(written[0].payload.total, n);
        } finally {
          await Deno.remove(dir, { recursive: true });
        }
      },
    ),
    { numRuns: Math.min(numRuns, 50) },
  );
});
