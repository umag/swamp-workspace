/**
 * Pure, device-free helpers for the Flipper Zero CLI protocol: ANSI stripping,
 * prompt detection, response cleaning, serial-port selection, and parsers for
 * `info device`, `storage list`, and `loader list` output.
 *
 * Everything here is deterministic and unit-tested without hardware; the actual
 * serial I/O lives in ./serial.ts.
 *
 * @module
 */

/** The interactive prompt string the Flipper CLI prints when idle. */
export const PROMPT = ">: ";

// Matches CSI/OSC ANSI escape sequences (colour, cursor moves, etc.). The ESC
// (0x1b) and 8-bit CSI (0x9b) introducers are built at runtime so no control
// characters appear in source (which would trip the no-control-regex lint).
const ANSI_RE = new RegExp(
  `[${String.fromCharCode(0x1b, 0x9b)}][[\\]()#;?]*` +
    `(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-PR-TZcf-ntqry=><~]`,
  "g",
);

// All C0 control characters except tab (0x09), newline (0x0a) and CR (0x0d),
// likewise assembled at runtime.
const CTRL_RE = new RegExp(
  `[${
    Array.from({ length: 0x20 }, (_, c) => c)
      .filter((c) => c !== 0x09 && c !== 0x0a && c !== 0x0d)
      .map((c) => String.fromCharCode(c))
      .join("")
  }]`,
  "g",
);

/** Remove ANSI escape sequences and stray control bytes from CLI output. */
export function stripAnsi(input: string): string {
  return input.replace(ANSI_RE, "").replace(CTRL_RE, "");
}

/** Normalise CR/CRLF line endings to `\n`. */
export function normalizeNewlines(input: string): string {
  return input.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

/**
 * True when the accumulated buffer ends with the Flipper CLI prompt, i.e. the
 * device has finished responding and is idle again.
 */
export function hasPrompt(buffer: string): boolean {
  const s = normalizeNewlines(stripAnsi(buffer));
  return /(?:^|\n)>:[ ]?$/.test(s);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Turn the raw bytes captured for a command into clean output text. A fresh
 * serial open emits a welcome banner then a prompt, and the Flipper echoes the
 * typed command, so the raw stream looks like:
 *
 *   `<banner>\r\n>: <command>\r\n<output>\r\n>: `
 *
 * This strips ANSI, normalises newlines, removes everything up to and including
 * the echoed command, drops the trailing prompt, and trims.
 */
export function cleanResponse(raw: string, command: string): string {
  let s = normalizeNewlines(stripAnsi(raw));
  // Drop the trailing idle prompt (and any trailing whitespace).
  s = s.replace(/\n?>:[ ]?[ \t]*$/, "").replace(/\s+$/, "");

  const cmd = command.trim();

  // Preferred: slice after the prompt-prefixed echo of our command.
  const anchor = `>: ${cmd}`;
  const anchorIdx = s.lastIndexOf(anchor);
  if (anchorIdx >= 0) {
    return s.slice(anchorIdx + anchor.length).replace(/^\r?\n/, "").trim();
  }

  // Echo without a visible prompt: slice after the echoed command line.
  const echoRe = new RegExp(`(^|\\n)${escapeRegExp(cmd)}(\\n|$)`);
  const echo = echoRe.exec(s);
  if (echo) {
    return s.slice(echo.index + echo[0].length).trim();
  }

  // No echo at all: drop a leading banner up to the first prompt, if present.
  const firstPrompt = s.indexOf(">: ");
  if (firstPrompt >= 0) {
    s = s.slice(firstPrompt + 3);
  }
  const lines = s.split("\n");
  if (lines.length > 0 && lines[0].trim() === cmd) lines.shift();
  return lines.join("\n").trim();
}

/**
 * Choose the serial device path for the Flipper. Honours an explicit override,
 * otherwise prefers a macOS `cu.usbmodemflip*` node, then a Linux `ttyACM*`
 * node, then any `cu.usbmodem*`. `names` are bare entries of `/dev`.
 *
 * @throws if nothing looks like a Flipper and no override was given.
 */
export function selectPort(names: string[], explicit?: string): string {
  if (explicit && explicit.trim().length > 0) return explicit.trim();

  const flip = names.filter((n) => /^cu\.usbmodemflip/i.test(n)).sort();
  if (flip.length > 0) return `/dev/${flip[0]}`;

  const acm = names.filter((n) => /^ttyACM\d+$/i.test(n)).sort();
  if (acm.length > 0) return `/dev/${acm[0]}`;

  const usbmodem = names.filter((n) => /^cu\.usbmodem/i.test(n)).sort();
  if (usbmodem.length > 0) return `/dev/${usbmodem[0]}`;

  throw new Error(
    "No Flipper serial device found. Looked for /dev/cu.usbmodemflip* (macOS) " +
      "or /dev/ttyACM* (Linux). Plug in and unlock the Flipper, close qFlipper " +
      "(it can hold the port), or set globalArguments.port explicitly.",
  );
}

/** The subset of `/dev` entries that could plausibly be a Flipper serial port. */
export function candidatePorts(names: string[]): string[] {
  return names
    .filter((n) => /^cu\.usbmodem/i.test(n) || /^ttyACM\d+$/i.test(n))
    .sort()
    .map((n) => `/dev/${n}`);
}

/** Parse `key : value` lines (e.g. `info device` output) into an object. */
export function parseDeviceInfo(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of normalizeNewlines(text).split("\n")) {
    const m = line.match(/^\s*([A-Za-z0-9_.\-]+)\s*:\s?(.*)$/);
    if (m) out[m[1]] = m[2].trim();
  }
  return out;
}

/** A single entry from `storage list`. */
export interface StorageEntry {
  type: "dir" | "file";
  name: string;
  size: number | null;
}

/**
 * Parse `storage list <path>` output. Lines look like `\t[D] subghz` for a
 * directory or `\t[F] Manifest 85176b` for a file whose byte size is printed
 * with a trailing `b` (older firmware omits the suffix).
 */
export function parseStorageList(text: string): StorageEntry[] {
  const out: StorageEntry[] = [];
  for (const line of normalizeNewlines(text).split("\n")) {
    const m = line.match(/^\s*\[([DF])\]\s+(.+?)(?:\s+(\d+)b?)?\s*$/);
    if (!m) continue;
    out.push({
      type: m[1] === "D" ? "dir" : "file",
      name: m[2],
      size: m[3] ? Number(m[3]) : null,
    });
  }
  return out;
}

/** Parse the `Size: <n>` header emitted by `storage read`, if present. */
export function parseFileSize(text: string): number | null {
  const m = normalizeNewlines(text).match(/^\s*Size:\s*(\d+)\s*$/m);
  return m ? Number(m[1]) : null;
}

/** Parse `loader list` output into a flat list of application ids. */
export function parseAppList(text: string): string[] {
  return normalizeNewlines(text)
    .split("\n")
    .map((l) => l.trim())
    .filter((l) =>
      l.length > 0 && !/:$/.test(l) && !/^Applications/i.test(l) &&
      !/command not found/i.test(l)
    );
}

/** A node from `storage tree`: a directory or file with an absolute path. */
export interface TreeEntry {
  type: "dir" | "file";
  path: string;
  size: number | null;
}

/**
 * Parse `storage tree <path>` output. Each line carries a full path, e.g.
 * `\t[D] /ext/apps/Games` or `\t[F] /ext/apps/Games/snake_game.fap 5840b`
 * (older firmware omits the `b` suffix).
 */
export function parseStorageTree(text: string): TreeEntry[] {
  const out: TreeEntry[] = [];
  for (const line of normalizeNewlines(text).split("\n")) {
    const m = line.match(/^\s*\[([DF])\]\s+(\/.+?)(?:\s+(\d+)b?)?\s*$/);
    if (!m) continue;
    out.push({
      type: m[1] === "D" ? "dir" : "file",
      path: m[2],
      size: m[3] ? Number(m[3]) : null,
    });
  }
  return out;
}

/** An installed application found on the SD card under an apps directory. */
export interface InstalledApp {
  /** File name, e.g. `snake_game.fap`. */
  name: string;
  /** File name without extension, e.g. `snake_game`. */
  id: string;
  /** Sub-path under the apps base, e.g. `Games` (empty if top-level). */
  category: string;
  /** `fap` (native app), `js` (script), or `other`. */
  kind: "fap" | "js" | "other";
  /** Absolute path on the device, usable with `loader open`. */
  path: string;
  /** Byte size, if known. */
  size: number | null;
}

function classifyApp(name: string): InstalledApp["kind"] {
  const dot = name.lastIndexOf(".");
  const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
  if (ext === "fap") return "fap";
  if (ext === "js") return "js";
  return "other";
}

/**
 * Turn `storage tree` file entries under `base` (e.g. `/ext/apps`) into a flat
 * list of installed apps, sorted by category then name. Directories are skipped.
 */
export function installedAppsFromTree(
  entries: TreeEntry[],
  base: string,
): InstalledApp[] {
  const root = base.replace(/\/+$/, "");
  const apps: InstalledApp[] = [];
  for (const e of entries) {
    if (e.type !== "file") continue;
    const rel = e.path.startsWith(root)
      ? e.path.slice(root.length).replace(/^\/+/, "")
      : e.path.replace(/^\/+/, "");
    const slash = rel.lastIndexOf("/");
    const name = slash >= 0 ? rel.slice(slash + 1) : rel;
    const category = slash >= 0 ? rel.slice(0, slash) : "";
    const dot = name.lastIndexOf(".");
    apps.push({
      name,
      id: dot > 0 ? name.slice(0, dot) : name,
      category,
      kind: classifyApp(name),
      path: e.path,
      size: e.size,
    });
  }
  apps.sort((a, b) =>
    a.category === b.category
      ? a.name.localeCompare(b.name)
      : a.category.localeCompare(b.category)
  );
  return apps;
}

/** Parse `loader info` output into the currently-running app, if any. */
export function parseLoaderInfo(
  text: string,
): { running: boolean; app: string | null } {
  const m = normalizeNewlines(stripAnsi(text)).match(
    /Application\s+"([^"]+)"\s+is running/i,
  );
  return m ? { running: true, app: m[1] } : { running: false, app: null };
}

/** True when CLI output signals an unknown/unsupported command. */
export function looksLikeUnknownCommand(text: string): boolean {
  return /command not found|unknown command|`[^`]+` command/i.test(text);
}

// Matches a main (`>: `) or sub-shell (`[nfc]>: `) prompt at the start of a line.
const ANY_PROMPT = /^\s*(?:\[[a-z0-9_-]+\])?>:\s?/i;
// The `nfc` command prints a dolphin drawn from '0' characters (with a stray
// digit in the eye, e.g. "0005"). Match digits+space only AND a run of zeros —
// widening to "all digits" would swallow legitimate numeric output.
const SPLASH_ART = /^[0-9\s]+$/;
function isSplashArt(line: string): boolean {
  return SPLASH_ART.test(line) && /000/.test(line);
}

/**
 * Clean the transcript of a multi-command session (see `sequenceCapture`).
 *
 * Unlike {@link cleanResponse}, which anchors on a single echoed command after
 * one `>: ` prompt, this copes with the prompt changing mid-session: it strips
 * any prompt prefix, drops lines that are just an echoed command, and discards
 * the connect banner plus the NFC ASCII-art splash.
 */
export function cleanSequenceOutput(raw: string, commands: string[]): string {
  const text = normalizeNewlines(stripAnsi(raw));
  const sent = new Set(commands.map((c) => c.trim()).filter((c) => c.length));
  const all = text.split("\n");

  // Everything before the first prompt is the connect banner.
  const firstPrompt = all.findIndex((l) => ANY_PROMPT.test(l));
  const lines = firstPrompt >= 0 ? all.slice(firstPrompt) : all;

  const kept: string[] = [];
  for (const line of lines) {
    const body = line.replace(ANY_PROMPT, "").trim();
    if (body.length === 0) continue;
    if (sent.has(body)) continue; // echoed command
    if (isSplashArt(body)) continue; // NFC splash art
    kept.push(body);
  }
  return kept.join("\n");
}

/** One decoded reception captured by a `listen` run. */
export interface ListenEvent {
  /** First line of the block — usually the protocol/summary line. */
  summary: string;
  /** All lines of the block. */
  lines: string[];
}

// Lines that are CLI chrome rather than an actual reception.
//
// NOTE: this is a denylist, and it is heuristic. Every receiver announces
// itself differently (sub-GHz prints a keystore banner + "Listening at
// frequency...", IR "Receiving INFRARED...", the NFC sub-shell a welcome +
// "Run `help`..."), so this has needed widening each time a new receiver was
// wired. It is grouped into two kinds: generic CLI chrome (welcome/help/prompt
// furniture, which is firmware-wide) and per-receiver status verbs. The full
// transcript is always preserved in the `output`/`raw` fields, so a missed
// pattern inflates `eventCount` but never loses data.
const LISTEN_NOISE = new RegExp(
  [
    // generic CLI chrome
    "^(welcome to|run `?help|find out more|available commands|press|use )",
    // per-receiver status verbs
    "^(listening|receiving|reading|scanning|waiting|searching|exit|rssi)",
    // sub-GHz specifics
    "^(no key|ok\\b|load_keystore|deleted|restarting|aborted)",
  ].join("|"),
  "i",
);

/**
 * Split captured receiver output into discrete events: blocks separated by
 * blank lines, with status lines stripped out. Blocks left empty are dropped.
 */
export function parseListenEvents(output: string): ListenEvent[] {
  const text = normalizeNewlines(stripAnsi(output));
  const events: ListenEvent[] = [];
  for (const block of text.split(/\n\s*\n/)) {
    const lines = block
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !LISTEN_NOISE.test(l));
    if (lines.length === 0) continue;
    events.push({ summary: lines[0], lines });
  }
  return events;
}

/** Flipper monochrome display dimensions. */
export const SCREEN_WIDTH = 128;
export const SCREEN_HEIGHT = 64;
const FRAMEBUFFER_SIZE = (SCREEN_WIDTH * SCREEN_HEIGHT) / 8; // 1024

/**
 * Locate the 1024-byte framebuffer inside captured RPC bytes. A `ScreenFrame`
 * carries it in field 1 (`data`, bytes) of length 1024, whose header on the
 * wire is `0x0A 0x80 0x08` (tag, then the varint length 1024).
 */
export function findScreenFrame(bytes: Uint8Array): Uint8Array | null {
  for (let i = 0; i + 3 + FRAMEBUFFER_SIZE <= bytes.length; i++) {
    if (bytes[i] === 0x0a && bytes[i + 1] === 0x80 && bytes[i + 2] === 0x08) {
      return bytes.slice(i + 3, i + 3 + FRAMEBUFFER_SIZE);
    }
  }
  return null;
}

// The framebuffer is page-major: byte (y>>3)*128 + x holds 8 vertical pixels
// for column x, LSB = topmost row of that page.
function framebufferPixel(fb: Uint8Array, x: number, y: number): boolean {
  return ((fb[(y >> 3) * SCREEN_WIDTH + x] >> (y & 7)) & 1) === 1;
}

/** Render the framebuffer as ASCII, 2x2 pixels per char (64x32). */
export function renderAscii(fb: Uint8Array): string {
  const ramp = [" ", ".", ":", "o", "#"];
  const rows: string[] = [];
  for (let y = 0; y < SCREEN_HEIGHT; y += 2) {
    let line = "";
    for (let x = 0; x < SCREEN_WIDTH; x += 2) {
      let on = 0;
      if (framebufferPixel(fb, x, y)) on++;
      if (framebufferPixel(fb, x + 1, y)) on++;
      if (framebufferPixel(fb, x, y + 1)) on++;
      if (framebufferPixel(fb, x + 1, y + 1)) on++;
      line += ramp[on];
    }
    rows.push(line);
  }
  return rows.join("\n");
}

/** Render the framebuffer as Unicode braille, 2x4 pixels per char (64x16). */
export function renderBraille(fb: Uint8Array): string {
  const dots = [[0x01, 0x08], [0x02, 0x10], [0x04, 0x20], [0x40, 0x80]];
  const rows: string[] = [];
  for (let y = 0; y < SCREEN_HEIGHT; y += 4) {
    let line = "";
    for (let x = 0; x < SCREEN_WIDTH; x += 2) {
      let mask = 0;
      for (let dy = 0; dy < 4; dy++) {
        for (let dx = 0; dx < 2; dx++) {
          if (framebufferPixel(fb, x + dx, y + dy)) mask |= dots[dy][dx];
        }
      }
      line += String.fromCharCode(0x2800 + mask);
    }
    rows.push(line);
  }
  return rows.join("\n");
}

/** Base64-encode the raw framebuffer so the image can be reconstructed later. */
export function framebufferBase64(fb: Uint8Array): string {
  let s = "";
  for (const b of fb) s += String.fromCharCode(b);
  return btoa(s);
}
