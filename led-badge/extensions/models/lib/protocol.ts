/**
 * Pure protocol code for the 44x11 "LED name badge" family (USB 0416:5020,
 * WCH CH583/CH582 based, also sold as LSLED / Badge Magic badges).
 *
 * Wire format (USB HID output reports, 64 bytes each):
 *   header (64 bytes)
 *     0..4   "wang\0"
 *     5      brightness: 0x00=100%, 0x10=75%, 0x20=50%, 0x40=25%
 *     6      blink bitmask (bit i = message i)
 *     7      marching-border ("ants") bitmask
 *     8..15  per message: ((speed-1) << 4) | mode
 *     16..31 per message: length in 8-pixel byte-columns, big-endian u16
 *     38..43 timestamp YY MM DD hh mm ss
 *   followed by each message's bitmap: per byte-column 11 bytes (one per row,
 *   MSB = leftmost pixel), padded with zeros to a multiple of 64 bytes.
 *
 * @module
 */

/** Display height in pixels. */
export const HEIGHT = 11;
/** Visible display width in pixels. */
export const WIDTH = 44;
/** Max number of stored messages. */
export const MAX_MESSAGES = 8;
/** Report size in bytes. */
export const REPORT_SIZE = 64;

/** Display modes, in protocol order. */
export const MODES = [
  "left",
  "right",
  "up",
  "down",
  "fixed",
  "animation",
  "snowflake",
  "picture",
  "laser",
] as const;

/** A display mode name. */
export type Mode = typeof MODES[number];

/** A pixel bitmap: rows[y][x] true = LED on. Always HEIGHT rows. */
export type Bitmap = boolean[][];

/** One message as stored on the badge. */
export interface Message {
  bitmap: Bitmap;
  mode: Mode;
  speed: number;
  blink: boolean;
  border: boolean;
}

// Classic 5x7 font (column-major, bit 0 = top row) for ASCII 0x20..0x7E.
const FONT_5X7: number[][] = [
  [0x00, 0x00, 0x00, 0x00, 0x00], // ' '
  [0x00, 0x00, 0x5f, 0x00, 0x00], // !
  [0x00, 0x07, 0x00, 0x07, 0x00], // "
  [0x14, 0x7f, 0x14, 0x7f, 0x14], // #
  [0x24, 0x2a, 0x7f, 0x2a, 0x12], // $
  [0x23, 0x13, 0x08, 0x64, 0x62], // %
  [0x36, 0x49, 0x55, 0x22, 0x50], // &
  [0x00, 0x05, 0x03, 0x00, 0x00], // '
  [0x00, 0x1c, 0x22, 0x41, 0x00], // (
  [0x00, 0x41, 0x22, 0x1c, 0x00], // )
  [0x14, 0x08, 0x3e, 0x08, 0x14], // *
  [0x08, 0x08, 0x3e, 0x08, 0x08], // +
  [0x00, 0x50, 0x30, 0x00, 0x00], // ,
  [0x08, 0x08, 0x08, 0x08, 0x08], // -
  [0x00, 0x60, 0x60, 0x00, 0x00], // .
  [0x20, 0x10, 0x08, 0x04, 0x02], // /
  [0x3e, 0x51, 0x49, 0x45, 0x3e], // 0
  [0x00, 0x42, 0x7f, 0x40, 0x00], // 1
  [0x42, 0x61, 0x51, 0x49, 0x46], // 2
  [0x21, 0x41, 0x45, 0x4b, 0x31], // 3
  [0x18, 0x14, 0x12, 0x7f, 0x10], // 4
  [0x27, 0x45, 0x45, 0x45, 0x39], // 5
  [0x3c, 0x4a, 0x49, 0x49, 0x30], // 6
  [0x01, 0x71, 0x09, 0x05, 0x03], // 7
  [0x36, 0x49, 0x49, 0x49, 0x36], // 8
  [0x06, 0x49, 0x49, 0x29, 0x1e], // 9
  [0x00, 0x36, 0x36, 0x00, 0x00], // :
  [0x00, 0x56, 0x36, 0x00, 0x00], // ;
  [0x08, 0x14, 0x22, 0x41, 0x00], // <
  [0x14, 0x14, 0x14, 0x14, 0x14], // =
  [0x00, 0x41, 0x22, 0x14, 0x08], // >
  [0x02, 0x01, 0x51, 0x09, 0x06], // ?
  [0x32, 0x49, 0x79, 0x41, 0x3e], // @
  [0x7e, 0x11, 0x11, 0x11, 0x7e], // A
  [0x7f, 0x49, 0x49, 0x49, 0x36], // B
  [0x3e, 0x41, 0x41, 0x41, 0x22], // C
  [0x7f, 0x41, 0x41, 0x22, 0x1c], // D
  [0x7f, 0x49, 0x49, 0x49, 0x41], // E
  [0x7f, 0x09, 0x09, 0x09, 0x01], // F
  [0x3e, 0x41, 0x49, 0x49, 0x7a], // G
  [0x7f, 0x08, 0x08, 0x08, 0x7f], // H
  [0x00, 0x41, 0x7f, 0x41, 0x00], // I
  [0x20, 0x40, 0x41, 0x3f, 0x01], // J
  [0x7f, 0x08, 0x14, 0x22, 0x41], // K
  [0x7f, 0x40, 0x40, 0x40, 0x40], // L
  [0x7f, 0x02, 0x0c, 0x02, 0x7f], // M
  [0x7f, 0x04, 0x08, 0x10, 0x7f], // N
  [0x3e, 0x41, 0x41, 0x41, 0x3e], // O
  [0x7f, 0x09, 0x09, 0x09, 0x06], // P
  [0x3e, 0x41, 0x51, 0x21, 0x5e], // Q
  [0x7f, 0x09, 0x19, 0x29, 0x46], // R
  [0x46, 0x49, 0x49, 0x49, 0x31], // S
  [0x01, 0x01, 0x7f, 0x01, 0x01], // T
  [0x3f, 0x40, 0x40, 0x40, 0x3f], // U
  [0x1f, 0x20, 0x40, 0x20, 0x1f], // V
  [0x3f, 0x40, 0x38, 0x40, 0x3f], // W
  [0x63, 0x14, 0x08, 0x14, 0x63], // X
  [0x07, 0x08, 0x70, 0x08, 0x07], // Y
  [0x61, 0x51, 0x49, 0x45, 0x43], // Z
  [0x00, 0x7f, 0x41, 0x41, 0x00], // [
  [0x02, 0x04, 0x08, 0x10, 0x20], // backslash
  [0x00, 0x41, 0x41, 0x7f, 0x00], // ]
  [0x04, 0x02, 0x01, 0x02, 0x04], // ^
  [0x40, 0x40, 0x40, 0x40, 0x40], // _
  [0x00, 0x01, 0x02, 0x04, 0x00], // `
  [0x20, 0x54, 0x54, 0x54, 0x78], // a
  [0x7f, 0x48, 0x44, 0x44, 0x38], // b
  [0x38, 0x44, 0x44, 0x44, 0x20], // c
  [0x38, 0x44, 0x44, 0x48, 0x7f], // d
  [0x38, 0x54, 0x54, 0x54, 0x18], // e
  [0x08, 0x7e, 0x09, 0x01, 0x02], // f
  [0x0c, 0x52, 0x52, 0x52, 0x3e], // g
  [0x7f, 0x08, 0x04, 0x04, 0x78], // h
  [0x00, 0x44, 0x7d, 0x40, 0x00], // i
  [0x20, 0x40, 0x44, 0x3d, 0x00], // j
  [0x7f, 0x10, 0x28, 0x44, 0x00], // k
  [0x00, 0x41, 0x7f, 0x40, 0x00], // l
  [0x7c, 0x04, 0x18, 0x04, 0x78], // m
  [0x7c, 0x08, 0x04, 0x04, 0x78], // n
  [0x38, 0x44, 0x44, 0x44, 0x38], // o
  [0x7c, 0x14, 0x14, 0x14, 0x08], // p
  [0x08, 0x14, 0x14, 0x18, 0x7c], // q
  [0x7c, 0x08, 0x04, 0x04, 0x08], // r
  [0x48, 0x54, 0x54, 0x54, 0x20], // s
  [0x04, 0x3f, 0x44, 0x40, 0x20], // t
  [0x3c, 0x40, 0x40, 0x20, 0x7c], // u
  [0x1c, 0x20, 0x40, 0x20, 0x1c], // v
  [0x3c, 0x40, 0x30, 0x40, 0x3c], // w
  [0x44, 0x28, 0x10, 0x28, 0x44], // x
  [0x0c, 0x50, 0x50, 0x50, 0x3c], // y
  [0x44, 0x64, 0x54, 0x4c, 0x44], // z
  [0x00, 0x08, 0x36, 0x41, 0x00], // {
  [0x00, 0x00, 0x7f, 0x00, 0x00], // |
  [0x00, 0x41, 0x36, 0x08, 0x00], // }
  [0x08, 0x04, 0x08, 0x10, 0x08], // ~
];

// Small symbols addressable in text as :name:.
const SYMBOLS: Record<string, string[]> = {
  heart: [
    ".##.##.",
    "#######",
    "#######",
    ".#####.",
    "..###..",
    "...#...",
  ],
  smile: [
    ".#####.",
    "#.....#",
    "#.#.#.#",
    "#.....#",
    "#.###.#",
    "#.....#",
    ".#####.",
  ],
  check: [
    "......#",
    ".....##",
    "#...##.",
    "##.##..",
    ".###...",
    "..#....",
  ],
  cross: [
    "#.....#",
    ".#...#.",
    "..#.#..",
    "...#...",
    "..#.#..",
    ".#...#.",
    "#.....#",
  ],
  arrow: [
    "...#...",
    "...##..",
    "#######",
    "...##..",
    "...#...",
  ],
};

/** Names usable as `:name:` in text. */
export const SYMBOL_NAMES = Object.keys(SYMBOLS);

/** Character cell row offset: 7-px glyphs sit on rows 2..8 of 11. */
const GLYPH_TOP = 2;

function emptyBitmap(width: number): Bitmap {
  return Array.from({ length: HEIGHT }, () => new Array(width).fill(false));
}

/** Columns of one glyph, each column a list of HEIGHT booleans. */
function glyphColumns(ch: string): boolean[][] {
  const code = ch.codePointAt(0) ?? 0x3f;
  const g = FONT_5X7[code - 0x20] ?? FONT_5X7[0x3f - 0x20];
  return g.map((byte) => {
    const col = new Array(HEIGHT).fill(false);
    for (let bit = 0; bit < 7; bit++) {
      if (byte & (1 << bit)) col[GLYPH_TOP + bit] = true;
    }
    return col;
  });
}

function symbolColumns(name: string): boolean[][] {
  const rows = SYMBOLS[name];
  const top = Math.floor((HEIGHT - rows.length) / 2);
  const w = rows[0].length;
  const cols: boolean[][] = [];
  for (let x = 0; x < w; x++) {
    const col = new Array(HEIGHT).fill(false);
    rows.forEach((r, y) => {
      if (r[x] === "#") col[top + y] = true;
    });
    cols.push(col);
  }
  return cols;
}

function colsToBitmap(cols: boolean[][]): Bitmap {
  const bm = emptyBitmap(cols.length);
  cols.forEach((col, x) => col.forEach((on, y) => (bm[y][x] = on)));
  return bm;
}

/**
 * Render text to a bitmap: 5x7 glyphs with 1-px spacing, proportional
 * (blank glyph columns trimmed, space = 3 px). `:heart:` etc. insert symbols.
 * Characters outside printable ASCII render as '?'.
 */
export function renderText(text: string): Bitmap {
  const cols: boolean[][] = [];
  const blank = () => new Array(HEIGHT).fill(false);
  const tokens = text.split(/(:[a-z]+:)/).filter((t) => t.length > 0);
  for (const tok of tokens) {
    const sym = /^:([a-z]+):$/.exec(tok);
    if (sym && SYMBOLS[sym[1]]) {
      cols.push(...symbolColumns(sym[1]), blank());
      continue;
    }
    for (const ch of tok) {
      if (ch === " ") {
        cols.push(blank(), blank(), blank());
        continue;
      }
      let g = glyphColumns(ch);
      while (g.length > 1 && !g[0].some(Boolean)) g = g.slice(1);
      while (g.length > 1 && !g[g.length - 1].some(Boolean)) {
        g = g.slice(0, -1);
      }
      cols.push(...g, blank());
    }
  }
  if (cols.length > 0) cols.pop();
  return colsToBitmap(cols);
}

/**
 * Parse pixel art: up to HEIGHT rows of '#'/'X'/'1' (on) and anything else
 * (off). Rows are padded to the widest row; short art is vertically centred.
 */
export function parseArt(rows: string[]): Bitmap {
  if (rows.length === 0 || rows.length > HEIGHT) {
    throw new Error(`pixel art needs 1..${HEIGHT} rows, got ${rows.length}`);
  }
  const width = Math.max(...rows.map((r) => r.length));
  if (width === 0) throw new Error("pixel art rows are empty");
  const bm = emptyBitmap(width);
  const top = Math.floor((HEIGHT - rows.length) / 2);
  rows.forEach((r, y) => {
    for (let x = 0; x < r.length; x++) {
      bm[top + y][x] = r[x] === "#" || r[x] === "X" || r[x] === "1";
    }
  });
  return bm;
}

/** Bitmap width in pixels. */
export function bitmapWidth(bm: Bitmap): number {
  return bm[0]?.length ?? 0;
}

/** Width of one frame in animation mode (6 byte-columns; 44 visible). */
export const FRAME_WIDTH = 48;
/** Max frames for one animation message (fits MAX_PAYLOAD_BYTES). */
export const MAX_FRAMES = 32;
/**
 * Largest upload this badge accepted (measured on a CH583 unit: 2048 and 2176
 * bytes play; 4032 bytes is silently ignored, the old content stays).
 */
export const MAX_PAYLOAD_BYTES = 2304;

/**
 * Build an animation-mode bitmap: each frame is pixel art (see parseArt),
 * centred in a 48-px slot; the badge shows the slots one after another.
 */
export function framesToBitmap(frames: string[][]): Bitmap {
  if (frames.length === 0 || frames.length > MAX_FRAMES) {
    throw new Error(`need 1..${MAX_FRAMES} frames, got ${frames.length}`);
  }
  const out = emptyBitmap(frames.length * FRAME_WIDTH);
  frames.forEach((rows, i) => {
    const bm = parseArt(rows);
    const w = bitmapWidth(bm);
    if (w > WIDTH) {
      throw new Error(`frame ${i} is ${w} px wide; max is ${WIDTH}`);
    }
    const left = i * FRAME_WIDTH + Math.floor((FRAME_WIDTH - w) / 2);
    bm.forEach((row, y) => row.forEach((on, x) => (out[y][left + x] = on)));
  });
  return out;
}

/** Centre a bitmap narrower than the display (nicer for fixed mode). */
export function centre(bm: Bitmap): Bitmap {
  const w = bitmapWidth(bm);
  if (w >= WIDTH) return bm;
  const left = Math.floor((WIDTH - w) / 2);
  const out = emptyBitmap(WIDTH);
  bm.forEach((row, y) => row.forEach((on, x) => (out[y][left + x] = on)));
  return out;
}

/** Pack a bitmap into 8-px byte-columns, 11 bytes each. */
export function packBitmap(bm: Bitmap): Uint8Array {
  const chunks = Math.max(1, Math.ceil(bitmapWidth(bm) / 8));
  const out = new Uint8Array(chunks * HEIGHT);
  for (let c = 0; c < chunks; c++) {
    for (let y = 0; y < HEIGHT; y++) {
      let byte = 0;
      for (let b = 0; b < 8; b++) {
        if (bm[y]?.[c * 8 + b]) byte |= 0x80 >> b;
      }
      out[c * HEIGHT + y] = byte;
    }
  }
  return out;
}

/** Protocol brightness byte for a percentage (25/50/75/100). */
export function brightnessByte(percent: number): number {
  if (percent <= 25) return 0x40;
  if (percent <= 50) return 0x20;
  if (percent <= 75) return 0x10;
  return 0x00;
}

/**
 * Build the full upload payload (header + bitmaps), zero-padded to a multiple
 * of `blockSize`: 64 for USB HID reports, 16 for BLE writes. The badge restarts
 * as soon as it has the bytes the header announces, so BLE must not send a
 * padding-only trailing write (it would hit a disconnected device).
 */
export function buildPayload(
  messages: Message[],
  brightnessPercent: number,
  now: Date,
  blockSize: number = REPORT_SIZE,
): Uint8Array {
  if (messages.length === 0 || messages.length > MAX_MESSAGES) {
    throw new Error(
      `need 1..${MAX_MESSAGES} messages, got ${messages.length}`,
    );
  }
  const header = new Uint8Array(REPORT_SIZE);
  header.set([0x77, 0x61, 0x6e, 0x67, 0x00], 0);
  header[5] = brightnessByte(brightnessPercent);
  for (let i = 8; i < 16; i++) header[i] = 0x40;
  const bodies: Uint8Array[] = [];
  messages.forEach((m, i) => {
    const mode = MODES.indexOf(m.mode);
    if (mode < 0) throw new Error(`unknown mode ${m.mode}`);
    if (!Number.isInteger(m.speed) || m.speed < 1 || m.speed > 8) {
      throw new Error(`speed must be 1..8, got ${m.speed}`);
    }
    if (m.blink) header[6] |= 1 << i;
    if (m.border) header[7] |= 1 << i;
    header[8 + i] = ((m.speed - 1) << 4) | mode;
    const body = packBitmap(m.bitmap);
    const len = body.length / HEIGHT;
    header[16 + 2 * i] = (len >> 8) & 0xff;
    header[17 + 2 * i] = len & 0xff;
    bodies.push(body);
  });
  header.set([
    now.getFullYear() % 100,
    now.getMonth() + 1,
    now.getDate(),
    now.getHours(),
    now.getMinutes(),
    now.getSeconds(),
  ], 38);
  const bodyLen = bodies.reduce((n, b) => n + b.length, 0);
  const total = Math.ceil((REPORT_SIZE + bodyLen) / blockSize) * blockSize;
  if (total > MAX_PAYLOAD_BYTES) {
    throw new Error(
      `payload is ${total} bytes; the badge silently ignores uploads above ` +
        `~${MAX_PAYLOAD_BYTES} bytes. Use fewer frames or shorter messages.`,
    );
  }
  const out = new Uint8Array(total);
  out.set(header, 0);
  let off = REPORT_SIZE;
  for (const b of bodies) {
    out.set(b, off);
    off += b.length;
  }
  return out;
}

/** Render a bitmap as text rows ('#' on, '.' off). */
export function renderAscii(bm: Bitmap): string[] {
  return bm.map((row) => row.map((on) => (on ? "#" : ".")).join(""));
}
