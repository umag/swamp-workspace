/**
 * Unit tests for the RPC message builders and the image/framebuffer layer.
 *
 * @module
 */

import { assertEquals, assertThrows } from "jsr:@std/assert@1";
import {
  frame,
  lenDelimited,
  sendInput,
  startScreenStream,
  startVirtualDisplay,
  stopVirtualDisplay,
  varint,
} from "./rpc.ts";
import {
  blankFramebuffer,
  FRAMEBUFFER_BYTES,
  framebufferFromAscii,
  framebufferFromBase64,
  getPixel,
  invertFramebuffer,
  setPixel,
} from "./image.ts";
import { framebufferBase64 } from "./protocol.ts";

Deno.test("varint encodes single and multi-byte values", () => {
  assertEquals(varint(0), [0x00]);
  assertEquals(varint(3), [0x03]);
  assertEquals(varint(127), [0x7f]);
  assertEquals(varint(128), [0x80, 0x01]);
  assertEquals(varint(1024), [0x80, 0x08]);
  assertEquals(varint(1034), [0x8a, 0x08]);
});

Deno.test("varint rejects negatives", () => {
  assertThrows(() => varint(-1), Error, "non-negative");
});

Deno.test("lenDelimited builds tag + length + payload", () => {
  // field 1, wire type 2 -> tag 0x0A
  assertEquals(
    Array.from(lenDelimited(1, new Uint8Array([0xaa, 0xbb]))),
    [0x0a, 0x02, 0xaa, 0xbb],
  );
});

Deno.test("startScreenStream matches the known-good wire bytes", () => {
  // Verified live against the device: 03 A2 01 00
  assertEquals(Array.from(startScreenStream()), [0x03, 0xa2, 0x01, 0x00]);
});

Deno.test("sendInput matches the known-good wire bytes", () => {
  // field 23, len 4, key=2 (RIGHT), type=0 (PRESS)
  assertEquals(
    Array.from(sendInput(2, 0)),
    [0x07, 0xba, 0x01, 0x04, 0x08, 0x02, 0x10, 0x00],
  );
});

Deno.test("stopVirtualDisplay is an empty field 27", () => {
  assertEquals(Array.from(stopVirtualDisplay()), [0x03, 0xda, 0x01, 0x00]);
});

Deno.test("startVirtualDisplay nests the framebuffer correctly", () => {
  const fb = blankFramebuffer();
  const bytes = startVirtualDisplay(fb);
  // frame(len) + PB_Main(field 26) + StartVirtualDisplayRequest(field 1)
  //   + ScreenFrame(field 1 = 1024 bytes)
  // ScreenFrame  = 1 tag + 2 len + 1024        = 1027
  // StartVirtual = 1 tag + 2 len + 1027        = 1030
  // PB_Main      = 2 tag + 2 len + 1030        = 1034
  // framed       = 2 len + 1034                = 1036
  assertEquals(bytes.length, 1036);
  assertEquals(Array.from(bytes.slice(0, 2)), [0x8a, 0x08]); // varint 1034
  assertEquals(Array.from(bytes.slice(2, 4)), [0xd2, 0x01]); // field 26 tag
});

Deno.test("frame prefixes the body length", () => {
  assertEquals(Array.from(frame(new Uint8Array([1, 2, 3]))), [3, 1, 2, 3]);
});

Deno.test("setPixel/getPixel round-trip in page-major layout", () => {
  const fb = blankFramebuffer();
  assertEquals(fb.length, FRAMEBUFFER_BYTES);
  setPixel(fb, 0, 0);
  assertEquals(fb[0], 0x01); // column 0, page 0, bit 0
  setPixel(fb, 5, 9);
  assertEquals(getPixel(fb, 5, 9), true);
  assertEquals(getPixel(fb, 5, 8), false);
  setPixel(fb, 5, 9, false);
  assertEquals(getPixel(fb, 5, 9), false);
});

Deno.test("setPixel ignores out-of-bounds coordinates", () => {
  const fb = blankFramebuffer();
  setPixel(fb, -1, 0);
  setPixel(fb, 999, 0);
  setPixel(fb, 0, 999);
  assertEquals(fb.every((b) => b === 0), true);
});

Deno.test("framebufferFromAscii lights non-blank chars", () => {
  // 2x1 art, scale 1, not centred -> pixels at (0,0) and (1,0)? '.' is blank.
  const fb = framebufferFromAscii("#.#", { scale: 1, center: false });
  assertEquals(getPixel(fb, 0, 0), true);
  assertEquals(getPixel(fb, 1, 0), false);
  assertEquals(getPixel(fb, 2, 0), true);
});

Deno.test("framebufferFromAscii scales and centres", () => {
  const fb = framebufferFromAscii("#", { scale: 4 });
  // 4x4 block centred on 128x64 -> origin (62, 30)
  assertEquals(getPixel(fb, 62, 30), true);
  assertEquals(getPixel(fb, 65, 33), true);
  assertEquals(getPixel(fb, 61, 30), false);
});

Deno.test("framebufferFromAscii rejects empty art", () => {
  assertThrows(() => framebufferFromAscii("   \n  "), Error, "empty");
});

Deno.test("invertFramebuffer flips every pixel", () => {
  const fb = blankFramebuffer();
  invertFramebuffer(fb);
  assertEquals(getPixel(fb, 0, 0), true);
  assertEquals(fb.every((b) => b === 0xff), true);
});

Deno.test("framebufferFromBase64 round-trips a framebuffer", () => {
  const fb = blankFramebuffer();
  setPixel(fb, 10, 20);
  const back = framebufferFromBase64(framebufferBase64(fb));
  assertEquals(back.length, FRAMEBUFFER_BYTES);
  assertEquals(getPixel(back, 10, 20), true);
});

Deno.test("framebufferFromBase64 rejects a wrong-sized payload", () => {
  assertThrows(
    () => framebufferFromBase64(btoa("too short")),
    Error,
    "exactly 1024 bytes",
  );
});
