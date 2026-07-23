/**
 * Build 128x64 1-bit framebuffers for the Flipper display.
 *
 * The framebuffer is page-major: byte `(y>>3)*128 + x` holds 8 vertical pixels
 * for column x, LSB = the topmost row of that page — the same layout the device
 * streams back over RPC.
 *
 * @module
 */

import { SCREEN_HEIGHT, SCREEN_WIDTH } from "./protocol.ts";

/** Bytes in one full framebuffer (128 * 64 / 8). */
export const FRAMEBUFFER_BYTES = (SCREEN_WIDTH * SCREEN_HEIGHT) / 8;

/** An all-blank framebuffer. */
export function blankFramebuffer(): Uint8Array {
  return new Uint8Array(FRAMEBUFFER_BYTES);
}

/** Light (or clear) a single pixel, ignoring out-of-bounds coordinates. */
export function setPixel(
  fb: Uint8Array,
  x: number,
  y: number,
  on = true,
): void {
  if (x < 0 || x >= SCREEN_WIDTH || y < 0 || y >= SCREEN_HEIGHT) return;
  const idx = (y >> 3) * SCREEN_WIDTH + x;
  const bit = 1 << (y & 7);
  if (on) fb[idx] |= bit;
  else fb[idx] &= ~bit & 0xff;
}

/** Read a pixel. */
export function getPixel(fb: Uint8Array, x: number, y: number): boolean {
  if (x < 0 || x >= SCREEN_WIDTH || y < 0 || y >= SCREEN_HEIGHT) return false;
  return ((fb[(y >> 3) * SCREEN_WIDTH + x] >> (y & 7)) & 1) === 1;
}

/** Invert every pixel in place. */
export function invertFramebuffer(fb: Uint8Array): Uint8Array {
  for (let i = 0; i < fb.length; i++) fb[i] = ~fb[i] & 0xff;
  return fb;
}

/** Characters treated as "background" when reading ASCII art. */
const BLANK = new Set([" ", "\t", ".", "·", "_", "0"]);

/** Options for {@link framebufferFromAscii}. */
export interface AsciiOptions {
  /** Pixels per source character. Omit to auto-fit the art to the screen. */
  scale?: number;
  /** Centre the art on the screen (default true); otherwise top-left. */
  center?: boolean;
  /** Invert the result (light background, dark art). */
  invert?: boolean;
}

/**
 * Render ASCII art onto a framebuffer. Any character other than space, tab,
 * `.`, `·`, `_` or `0` lights a pixel. The art is scaled up by an integer
 * factor to fill the display as far as it fits, and centred by default.
 *
 * @throws if the art is empty.
 */
export function framebufferFromAscii(
  art: string,
  opts: AsciiOptions = {},
): Uint8Array {
  const lines = art.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  while (lines.length > 0 && lines[lines.length - 1].trim() === "") lines.pop();
  const height = lines.length;
  const width = lines.reduce((m, l) => Math.max(m, l.length), 0);
  if (height === 0 || width === 0) {
    throw new Error("ASCII art is empty — nothing to draw.");
  }

  const fit = Math.min(
    Math.floor(SCREEN_WIDTH / width),
    Math.floor(SCREEN_HEIGHT / height),
  );
  const scale = Math.max(1, opts.scale ?? Math.max(1, fit));

  const drawnW = width * scale;
  const drawnH = height * scale;
  const center = opts.center !== false;
  const ox = center ? Math.max(0, Math.floor((SCREEN_WIDTH - drawnW) / 2)) : 0;
  const oy = center ? Math.max(0, Math.floor((SCREEN_HEIGHT - drawnH) / 2)) : 0;

  const fb = blankFramebuffer();
  for (let row = 0; row < height; row++) {
    const line = lines[row];
    for (let col = 0; col < width; col++) {
      const ch = col < line.length ? line[col] : " ";
      if (BLANK.has(ch)) continue;
      for (let dy = 0; dy < scale; dy++) {
        for (let dx = 0; dx < scale; dx++) {
          setPixel(fb, ox + col * scale + dx, oy + row * scale + dy, true);
        }
      }
    }
  }
  return opts.invert ? invertFramebuffer(fb) : fb;
}

/**
 * Decode a base64 framebuffer (e.g. one captured by `screenshot`).
 *
 * @throws if the payload is not exactly {@link FRAMEBUFFER_BYTES} bytes.
 */
export function framebufferFromBase64(b64: string): Uint8Array {
  const raw = atob(b64.trim());
  if (raw.length !== FRAMEBUFFER_BYTES) {
    throw new Error(
      `Framebuffer must be exactly ${FRAMEBUFFER_BYTES} bytes, got ${raw.length}.`,
    );
  }
  const fb = new Uint8Array(FRAMEBUFFER_BYTES);
  for (let i = 0; i < raw.length; i++) fb[i] = raw.charCodeAt(i);
  return fb;
}
