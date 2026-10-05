import { assertEquals, assertThrows } from "jsr:@std/assert@1";
import {
  buildPayload,
  FRAME_WIDTH,
  framesToBitmap,
  HEIGHT,
  packBitmap,
  parseArt,
  renderText,
} from "./protocol.ts";

Deno.test("header carries magic, mode/speed, length and brightness", () => {
  const bitmap = renderText("Hi");
  const p = buildPayload(
    [{ bitmap, mode: "fixed", speed: 3, blink: true, border: false }],
    50,
    new Date(2026, 9, 5, 12, 34, 56),
  );
  assertEquals(Array.from(p.slice(0, 5)), [0x77, 0x61, 0x6e, 0x67, 0]);
  assertEquals(p[5], 0x20);
  assertEquals(p[6], 0b1);
  assertEquals(p[8], (2 << 4) | 4);
  assertEquals(p[9], 0x40);
  assertEquals((p[16] << 8) | p[17], 2); // 'H'(5)+1+'i'(3) = 9px → 2 cols
  assertEquals(Array.from(p.slice(38, 44)), [26, 10, 5, 12, 34, 56]);
  assertEquals(p.length % 64, 0);
});

Deno.test("packBitmap: MSB is the leftmost pixel, 11 bytes per column", () => {
  const bm = parseArt(["#........#"]);
  const packed = packBitmap(bm);
  assertEquals(packed.length, 2 * HEIGHT);
  assertEquals(packed[5], 0x80); // row 5 (centred), col 0
  assertEquals(packed[HEIGHT + 5], 0x40); // second column, px 9
});

Deno.test("rejects bad input", () => {
  assertThrows(() => parseArt([]));
  assertThrows(() => buildPayload([], 100, new Date()));
});

Deno.test("framesToBitmap: one 48-px slot per frame, content centred", () => {
  const bm = framesToBitmap([["#"], ["##"]]);
  assertEquals(bm[0].length, 2 * FRAME_WIDTH);
  assertEquals(bm[5].indexOf(true), 23);
  assertEquals(bm[5].lastIndexOf(true), FRAME_WIDTH + 24);
  assertThrows(() => framesToBitmap([]));
  assertThrows(() => framesToBitmap([["#".repeat(45)]]));
});

Deno.test("buildPayload refuses uploads the badge would silently ignore", () => {
  const big = framesToBitmap(Array.from({ length: 32 }, () => ["#"]));
  const msg = {
    bitmap: big,
    mode: "animation" as const,
    speed: 8,
    blink: false,
    border: false,
  };
  buildPayload([msg], 100, new Date()); // 32 frames fits
  assertThrows(
    () => buildPayload([msg, msg], 100, new Date()),
    Error,
    "silently ignores",
  );
});

Deno.test("BLE padding: no padding-only trailing 16-byte block", () => {
  const msg = {
    bitmap: renderText("Magistr - Bog Keeper"),
    mode: "left" as const,
    speed: 5,
    blink: false,
    border: false,
  };
  const usb = buildPayload([msg], 50, new Date());
  const ble = buildPayload([msg], 50, new Date(), 16);
  const needed = 64 + ((usb[16] << 8) | usb[17]) * 11;
  assertEquals(usb.length % 64, 0);
  assertEquals(ble.length, Math.ceil(needed / 16) * 16);
  assertEquals(ble.length < usb.length, true);
});
