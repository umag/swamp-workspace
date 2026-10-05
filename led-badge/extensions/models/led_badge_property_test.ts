/**
 * Property-based tests (fast-check) for @magistr/led-badge's pure protocol
 * layer (lib/protocol.ts). Named invariants:
 *
 *  (a) packBitmap round-trips: unpacking the 11-byte columns gives back the
 *      bitmap, zero-padded to a multiple of 8 px.
 *  (b) buildPayload output is a multiple of the block size (16 or 64), starts
 *      with "wang", carries each message's byte-column length, and never
 *      exceeds MAX_PAYLOAD_BYTES (it throws instead).
 *  (c) renderText never throws and always yields HEIGHT equal-width rows.
 *  (d) parseArt lights exactly the '#', 'X' and '1' characters.
 *  (e) framesToBitmap is FRAME_WIDTH px per frame and preserves lit pixels.
 */
import fc from "npm:fast-check@4.8.0";
import { assert, assertEquals, assertThrows } from "jsr:@std/assert@1";
import {
  type Bitmap,
  buildPayload,
  FRAME_WIDTH,
  framesToBitmap,
  HEIGHT,
  MAX_PAYLOAD_BYTES,
  MODES,
  packBitmap,
  parseArt,
  renderText,
} from "./lib/protocol.ts";

const numRuns = Number(Deno.env.get("FC_NUM_RUNS") ?? 200);

const bitmapArb = fc.integer({ min: 1, max: 120 }).chain((w) =>
  fc.array(fc.array(fc.boolean(), { minLength: w, maxLength: w }), {
    minLength: HEIGHT,
    maxLength: HEIGHT,
  })
);

const lit = (bm: Bitmap) => bm.flat().filter(Boolean).length;

Deno.test("(a) packBitmap round-trips", () => {
  fc.assert(
    fc.property(bitmapArb, (bm) => {
      const packed = packBitmap(bm);
      const cols = packed.length / HEIGHT;
      assertEquals(cols, Math.ceil(bm[0].length / 8));
      for (let y = 0; y < HEIGHT; y++) {
        for (let x = 0; x < cols * 8; x++) {
          const on = (packed[Math.floor(x / 8) * HEIGHT + y] &
            (0x80 >> (x % 8))) !== 0;
          assertEquals(on, bm[y][x] ?? false);
        }
      }
    }),
    { numRuns },
  );
});

Deno.test("(b) buildPayload framing invariants", () => {
  const msgArb = fc.record({
    bitmap: bitmapArb,
    mode: fc.constantFrom(...MODES),
    speed: fc.integer({ min: 1, max: 8 }),
    blink: fc.boolean(),
    border: fc.boolean(),
  });
  fc.assert(
    fc.property(
      fc.array(msgArb, { minLength: 1, maxLength: 8 }),
      fc.constantFrom(16, 64),
      fc.constantFrom(25, 50, 75, 100),
      (msgs, block, bright) => {
        const body = msgs.reduce((n, m) => n + packBitmap(m.bitmap).length, 0);
        const expected = Math.ceil((64 + body) / block) * block;
        if (expected > MAX_PAYLOAD_BYTES) {
          assertThrows(() => buildPayload(msgs, bright, new Date(), block));
          return;
        }
        const p = buildPayload(msgs, bright, new Date(), block);
        assertEquals(p.length, expected);
        assertEquals(p.length % block, 0);
        assertEquals(new TextDecoder().decode(p.slice(0, 4)), "wang");
        msgs.forEach((m, i) => {
          assertEquals(
            (p[16 + 2 * i] << 8) | p[17 + 2 * i],
            Math.ceil(m.bitmap[0].length / 8),
          );
          assertEquals(p[8 + i] & 0x0f, MODES.indexOf(m.mode));
          assertEquals((p[8 + i] >> 4) + 1, m.speed);
          assertEquals(((p[6] >> i) & 1) === 1, m.blink);
          assertEquals(((p[7] >> i) & 1) === 1, m.border);
        });
      },
    ),
    { numRuns },
  );
});

Deno.test("(c) renderText is total and rectangular", () => {
  fc.assert(
    fc.property(fc.string({ maxLength: 60 }), (s) => {
      const bm = renderText(s);
      assertEquals(bm.length, HEIGHT);
      assert(bm.every((r) => r.length === bm[0].length));
    }),
    { numRuns },
  );
});

Deno.test("(d) parseArt lights exactly #, X and 1", () => {
  fc.assert(
    fc.property(
      fc.array(fc.string({ minLength: 1, maxLength: 44 }), {
        minLength: 1,
        maxLength: HEIGHT,
      }),
      (rows) => {
        const want =
          rows.join("").split("").filter((c) =>
            c === "#" || c === "X" || c === "1"
          ).length;
        assertEquals(lit(parseArt(rows)), want);
      },
    ),
    { numRuns },
  );
});

Deno.test("(e) framesToBitmap slots and preserves pixels", () => {
  const frameArb = fc.array(
    fc.stringMatching(/^[#.]{1,44}$/),
    { minLength: 1, maxLength: HEIGHT },
  );
  fc.assert(
    fc.property(fc.array(frameArb, { minLength: 1, maxLength: 32 }), (fs) => {
      const bm = framesToBitmap(fs);
      assertEquals(bm[0].length, fs.length * FRAME_WIDTH);
      assertEquals(lit(bm), fs.reduce((n, f) => n + lit(parseArt(f)), 0));
    }),
    { numRuns },
  );
});
