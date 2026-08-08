// @magistr/music-library — multidimensional catalog of a music share.
//
// The library inventory and raw tags come from an existing gonic scan index
// (gonic.db, read over SSH with sqlite3 -json) — the filesystem is NEVER
// traversed, so no unraid array disk is woken up. On top of that raw data the
// model builds a star-schema cube:
//
//   facts:       one `album` resource per album directory (album→disc→track)
//   dimensions:  one `artist` resource per artist; rollups for genres,
//                years/decades, formats, quality buckets
//   cross-cuts:  `issues` worklists (untagged, dirname-only, encoding fixes,
//                DOS-mangled names) and a `library` summary
//
// Tag strings pass through encoding recovery: legacy single-byte tags decoded
// as latin1 by taggers (cp1251/koi8-r/cp866/… mojibake such as
// "Êëàóäèî Ìîíòåâåðäè") and double-encoded UTF-8 are detected with jschardet
// and re-decoded. Tracks with missing tags fall back to directory / filename
// naming patterns ("1983. Artist - Album", "Artist - Album (Year)",
// "NN - Title", disc subdirs, …).

import { z } from "npm:zod@4";
import jschardet from "npm:jschardet@3.1.4";
import { buildRunning, type RunTrack } from "../lib/running.ts";
import {
  type Candidate,
  escapeLuceneQuery,
  matchArtist,
} from "../lib/artist_match.ts";
import {
  deriveWanted,
  type DesiredReleaseGroup,
  type OwnedAlbum,
  QUALITY_RANK,
  type QualityBucket,
  type ResolvedArtist,
} from "../lib/wanted.ts";
import { isNoiseGroup, normDupeKey } from "../lib/norm.ts";

// --- Global arguments ---

const GlobalArgsSchema = z.object({
  host: z.string().describe("Host with the music share (unraid)"),
  sshUser: z.string().default("root").describe("SSH user"),
  dbPath: z
    .string()
    .default("/mnt/user/media-server/gonicdata/gonic.db")
    .describe("Path of the gonic SQLite index on the host"),
  container: z
    .string()
    .default("gonic")
    .describe("Docker container that has ffprobe and the music mount"),
  containerMusicRoot: z
    .string()
    .default("/music")
    .describe("Music root path inside the container (gonic root_dir)"),
  hostMusicRoot: z
    .string()
    .default("/mnt/user/music")
    .describe("Music root path on the host"),
  bpmImage: z
    .string()
    .default("mtgupf/essentia:latest")
    .describe(
      "Docker image with the essentia python bindings, used by the bpm method",
    ),
  legacyEncodings: z
    .array(z.string())
    .default(["windows-1251", "koi8-r", "ibm866", "shift_jis", "gbk"])
    .describe(
      "Charsets tag-encoding recovery may re-decode, in preference order (jschardet names)",
    ),
  ffmpegDecodeTimeoutSec: z
    .number()
    .int()
    .min(0)
    .default(600)
    .describe(
      "Per-file guard around verify's remote ffmpeg decode (0 = no timeout): wrapped with the shell `timeout` command so a single wedged/oversized file is recorded as failed and the worker's chunk keeps going, instead of hanging forever. Also sizes the client-side transport-ceiling AbortController on each worker's ssh call (a generous multiple of this, so it only fires if the remote timeout itself failed or ssh/network wedged)",
    ),
});

// --- SSH helpers ---

function shQuote(s: string): string {
  return "'" + String(s).replaceAll("'", `'\\''`) + "'";
}

async function sshRun(
  host: string,
  sshUser: string,
  command: string,
  stdinText?: string,
  timeoutMs?: number,
): Promise<string> {
  // Transport-ceiling AbortController: bounds the WHOLE ssh call (not a
  // per-file guard — that lives in the remote shell `timeout` command
  // instead, see verify's fullScript/quickScript). Only actually fires when a
  // caller passes a positive timeoutMs; the timer is always cleared in
  // `finally` (never AbortSignal.timeout()) so it can never leak and trip
  // Deno's test op-sanitizer.
  const ac = new AbortController();
  const timer = timeoutMs && timeoutMs > 0
    ? setTimeout(() => ac.abort(), timeoutMs)
    : undefined;
  try {
    const cmd = new Deno.Command("ssh", {
      args: [
        "-o",
        "StrictHostKeyChecking=no",
        "-o",
        "UserKnownHostsFile=/dev/null",
        "-o",
        "ConnectTimeout=10",
        "-o",
        "BatchMode=yes",
        // Keep multi-hour sessions (whole-library bpm/verify runs) from being
        // torn down by an idle-NAT timeout or a brief network blip: probe every
        // 20s, tolerate ~2min of silence before giving up.
        "-o",
        "ServerAliveInterval=20",
        "-o",
        "ServerAliveCountMax=6",
        `${sshUser}@${host}`,
        command,
      ],
      stdin: stdinText === undefined ? "null" : "piped",
      stdout: "piped",
      stderr: "piped",
      signal: ac.signal,
    });
    const proc = cmd.spawn();
    if (stdinText !== undefined) {
      const writer = proc.stdin.getWriter();
      await writer.write(new TextEncoder().encode(stdinText));
      await writer.close();
    }
    const output = await proc.output();
    const stdout = new TextDecoder().decode(output.stdout);
    const stderr = new TextDecoder().decode(output.stderr);
    if (!output.success) {
      const real = stderr
        .split("\n")
        .filter((l) => !l.includes("Warning: Permanently added") && l.trim())
        .join("\n");
      throw new Error(`ssh command failed: ${real || stdout}`);
    }
    return stdout;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Split a path into normalized segments: drop `.`/empty segments, pop the
 * previous segment on `..`, and throw when a `..` would pop past the root.
 * Splits on BOTH `/` and `\` so a backslash cannot smuggle a traversal
 * sequence past a forward-slash-only splitter (mirrors obsidian-vault's
 * segment guard).
 */
export function normalizeSegments(path: string): string[] {
  const segments: string[] = [];
  for (const raw of path.split(/[/\\]/)) {
    if (!raw || raw === ".") continue;
    if (raw === "..") {
      if (segments.length === 0) {
        throw new Error(`Path escapes music root: ${path}`);
      }
      segments.pop();
      continue;
    }
    segments.push(raw);
  }
  return segments;
}

/**
 * Resolve a caller-supplied `path` argument (library-relative, or an
 * absolute host/container path) to a container path confined under
 * `containerMusicRoot`. Shared by verify/bpm/probe's single-`path` branch —
 * the previous per-method inline block only stripped LEADING slashes, so
 * `../` escaped the root verbatim; this normalizes the remainder against
 * `containerMusicRoot` and throws rather than resolving outside it.
 */
export function confineContainerPath(
  hostMusicRoot: string,
  containerMusicRoot: string,
  requested: string,
): string {
  let p = requested;
  if (p.startsWith(hostMusicRoot + "/")) {
    p = containerMusicRoot + p.slice(hostMusicRoot.length);
  } else if (!p.startsWith(containerMusicRoot + "/")) {
    p = containerMusicRoot + "/" + p.replace(/^\/+/, "");
  }
  const rest = p.slice(containerMusicRoot.length + 1);
  const segments = normalizeSegments(rest);
  return containerMusicRoot +
    (segments.length ? "/" + segments.join("/") : "");
}

async function sqliteJson(
  host: string,
  sshUser: string,
  dbPath: string,
  sql: string,
) {
  const out = await sshRun(
    host,
    sshUser,
    `sqlite3 -json -readonly ${shQuote(dbPath)}`,
    sql + "\n",
  );
  const trimmed = out.trim();
  if (!trimmed) return [];
  return JSON.parse(trimmed);
}

// --- Encoding recovery ---

// jschardet names → TextDecoder labels (only re-decoders we trust for
// latin1-shaped mojibake).
const DECODER_LABELS = {
  "windows-1251": "windows-1251",
  "koi8-r": "koi8-r",
  "ibm866": "ibm866",
  "maccyrillic": "x-mac-cyrillic",
  "windows-1252": "windows-1252",
  "windows-1250": "windows-1250",
  "windows-1253": "windows-1253",
  "windows-1254": "windows-1254",
  "windows-1255": "windows-1255",
  "windows-1256": "windows-1256",
  "windows-1257": "windows-1257",
  "iso-8859-2": "iso-8859-2",
  "iso-8859-5": "iso-8859-5",
  "iso-8859-7": "iso-8859-7",
  "shift_jis": "shift_jis",
  "sjis": "shift_jis",
  "gb2312": "gbk",
  "gbk": "gbk",
  "big5": "big5",
  "euc-jp": "euc-jp",
  "euc-kr": "euc-kr",
  "tis-620": "windows-874",
};

// Encodings that would be a no-op or are what the text already is.
const NOOP_ENCODINGS = new Set(["ascii", "utf-8", "utf8", "iso-8859-1"]);

function isLatin1Shaped(s: string): boolean {
  let hasHigh = false;
  for (const ch of s) {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp > 0xff) return false;
    if (cp >= 0x80) hasHigh = true;
  }
  return hasHigh;
}

function latin1Bytes(s: string): Uint8Array {
  const bytes = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i);
  return bytes;
}

// Single-byte Cyrillic charsets get an extra structural gate (see
// hasLegacyWordShape) because they are jschardet's most frequent false
// positive on accented Western text (Icelandic "Blóð", French "Mémoire").
const CYRILLIC_SINGLE_BYTE = new Set([
  "windows-1251",
  "koi8-r",
  "ibm866",
  "maccyrillic",
  "iso-8859-5",
]);

/**
 * Default value of the `legacyEncodings` global argument, and the fallback
 * `allowed` set `fixEncoding` uses when a caller doesn't pass one: the
 * single- and multi-byte charsets old taggers on this share are known to
 * have mis-saved as latin1. windows-1251/koi8-r/ibm866 cover the Cyrillic
 * mojibake noted at the top of this file ("Êëàóäèî Ìîíòåâåðäè"); shift_jis
 * and gbk cover Japanese and simplified-Chinese collections mixed into the
 * same share. Anything else jschardet suggests — in particular the
 * Western-European windows-125x charsets — is ignored unless a caller
 * widens `legacyEncodings` explicitly, because those are exactly what
 * hasLegacyWordShape's structural gate exists to reject: jschardet's most
 * frequent false positive is accented Western text (Icelandic "Blóð",
 * French "Mémoire") misread as legacy Cyrillic.
 */
export const DEFAULT_LEGACY_ENCODINGS = [
  "windows-1251",
  "koi8-r",
  "ibm866",
  "shift_jis",
  "gbk",
];

/**
 * Legacy single-byte non-Latin text (cp1251/koi8-r Cyrillic, ...) encodes
 * whole words with high bytes; Western accented text (Icelandic, French)
 * has mostly-ASCII words with sparse accents. Require every word that
 * contains a high byte to be >=85% high-byte letters — this keeps
 * "Êëàóäèî" (7/7 high) and rejects "Blóð" (2/4 high).
 */
function hasLegacyWordShape(s: string): boolean {
  const words = s.split(/[^0-9A-Za-z\u0080-\u00ff]+/);
  let sawHighWord = false;
  for (const w of words) {
    const letters = [...w].filter((c) => /[A-Za-z\u0080-\u00ff]/.test(c));
    const high = letters.filter((c) => c.charCodeAt(0) >= 0x80);
    if (high.length === 0) continue;
    sawHighWord = true;
    if (high.length / letters.length < 0.85) return false;
  }
  return sawHighWord;
}

// The ten most frequent Russian letters cover ~70% of real Russian text;
// a wrong single-byte Cyrillic decode yields shifted-case garbage where the
// ratio drops to ~30%.
const RU_TOP10 = new Set([..."оеаинтсрвл"]);

function cyrillicScore(decoded: string): number {
  const nonAscii = [...decoded].filter((c) => c.charCodeAt(0) > 0x7f);
  if (nonAscii.length === 0) return 0;
  const cyr = nonAscii.filter((c) => /\p{Script=Cyrillic}/u.test(c));
  if (cyr.length / nonAscii.length < 0.9) return 0;
  const common = cyr.filter((c) => RU_TOP10.has(c.toLowerCase()));
  return common.length / cyr.length;
}

function detectCandidates(
  s: string,
): { encoding: string | null; confidence: number }[] {
  const jd = jschardet as unknown as {
    detect: (x: string) => { encoding: string | null; confidence: number };
    detectAll?: (
      x: string,
    ) => { encoding: string | null; confidence: number }[];
  };
  if (typeof jd.detectAll === "function") {
    const all = jd.detectAll(s);
    if (Array.isArray(all) && all.length > 0) return all;
  }
  return [jd.detect(s)];
}

/**
 * Recover a tag string that was decoded as latin1 by a tagger although its
 * bytes were really cp1251 / koi8-r / double-encoded UTF-8 / etc.
 * Returns { value, fixed, encoding } — `value` is unchanged when the string
 * is already sane. `allowed` restricts which charsets may be re-decoded.
 */
export function fixEncoding(
  s: string,
  depth = 0,
  allowed: Set<string> = new Set(DEFAULT_LEGACY_ENCODINGS),
): {
  value: string;
  fixed: boolean;
  encoding: string | null;
} {
  if (!s || depth > 2) return { value: s, fixed: false, encoding: null };
  if (!isLatin1Shaped(s)) return { value: s, fixed: false, encoding: null };

  const bytes = latin1Bytes(s);

  // 1. Double-encoded UTF-8: latin1-shaped string whose bytes are valid
  //    multi-byte UTF-8 ("BÃ¶ses" → "Böses").
  try {
    const utf8 = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (utf8 !== s) {
      const deeper = fixEncoding(utf8, depth + 1, allowed);
      return {
        value: deeper.fixed ? deeper.value : utf8,
        fixed: true,
        encoding: deeper.fixed ? `utf-8+${deeper.encoding}` : "utf-8(double)",
      };
    }
  } catch {
    // not valid UTF-8 — fall through to charset detection
  }

  // 2. Charset detection: walk jschardet's ranked candidates and take the
  //    first allowed one that passes the structural gates. Detection runs on
  //    the high-byte words only — ASCII-heavy strings ("Îïåðà ( L'Orfeo )
  //    (John Eliott Gardiner)") would otherwise dilute the confidence.
  const wordShapeOk = hasLegacyWordShape(s);
  const highWords = s
    .split(/[^0-9A-Za-z\u0080-\u00ff'’]+/)
    .filter((w) => [...w].some((c) => c.charCodeAt(0) >= 0x80))
    .join(" ");
  if (!highWords) return { value: s, fixed: false, encoding: null };
  for (const det of detectCandidates(highWords)) {
    const detName = (det.encoding || "").toLowerCase();
    if (!detName || NOOP_ENCODINGS.has(detName)) continue;
    if (!allowed.has(detName)) continue;
    const label = DECODER_LABELS[detName];
    if (!label) continue;
    if (CYRILLIC_SINGLE_BYTE.has(detName)) {
      // the word-shape gate is a strong structural signal, so a lower
      // detector confidence is acceptable for ranked candidates
      if (!wordShapeOk || det.confidence < 0.5) continue;
    } else if (det.confidence < 0.75) {
      continue;
    }
    // windows-1252 differs from latin1 only in 0x80-0x9F: only re-decode
    // when such bytes are actually present.
    if (detName === "windows-1252" && !/[\u0080-\u009f]/.test(s)) continue;
    try {
      const decoded = new TextDecoder(label).decode(bytes);
      if (decoded === s || decoded.includes("\uFFFD")) continue;
      if (CYRILLIC_SINGLE_BYTE.has(detName)) {
        // re-decoded text must actually be Cyrillic-dominated
        const nonAscii = [...decoded].filter((c) => c.charCodeAt(0) > 0x7f);
        const cyr = nonAscii.filter((c) => /\p{Script=Cyrillic}/u.test(c));
        if (nonAscii.length === 0 || cyr.length / nonAscii.length < 0.85) {
          continue;
        }
      }
      return { value: decoded, fixed: true, encoding: detName };
    } catch {
      // decoder label unsupported — try the next candidate
    }
  }

  // 3. Trial decode: jschardet's Cyrillic models need long text and misfire
  //    on short phrases (e.g. "Îïåðà Îðôåé" → ISO-8859-8). When the string
  //    is structurally legacy-shaped, try the allowed single-byte Cyrillic
  //    charsets in allowlist order and accept the first decode that passes
  //    the Russian letter-frequency gate — which rejects the shifted-case
  //    garbage a wrong Cyrillic charset produces.
  if (wordShapeOk) {
    for (const name of allowed) {
      if (!CYRILLIC_SINGLE_BYTE.has(name)) continue;
      const label = DECODER_LABELS[name];
      if (!label) continue;
      try {
        const decoded = new TextDecoder(label).decode(bytes);
        if (decoded === s || decoded.includes("\uFFFD")) continue;
        if (cyrillicScore(decoded) >= 0.45) {
          return { value: decoded, fixed: true, encoding: name };
        }
      } catch {
        // decoder label unsupported — try the next charset
      }
    }
  }
  return { value: s, fixed: false, encoding: null };
}

// --- Placeholder tags ---

const PLACEHOLDER_RE =
  /^(unknown( artist| album| title)?|неизвест\S*( исполнитель)?|untitled|no title|track\s*\d*|дорожка\s*\d*|audiotrack\s*\d*|new artist|new title|artist|title|album|va|-+|\?+)$/iu;

/** True for tagger placeholder values that carry no information. */
export function isPlaceholder(s: string | null | undefined): boolean {
  if (!s) return true;
  const t = s.trim();
  if (!t) return true;
  return PLACEHOLDER_RE.test(t);
}

// --- Naming helpers ---

const CYR_TRANSLIT = {
  а: "a",
  б: "b",
  в: "v",
  г: "g",
  д: "d",
  е: "e",
  ё: "e",
  ж: "zh",
  з: "z",
  и: "i",
  й: "j",
  к: "k",
  л: "l",
  м: "m",
  н: "n",
  о: "o",
  п: "p",
  р: "r",
  с: "s",
  т: "t",
  у: "u",
  ф: "f",
  х: "h",
  ц: "c",
  ч: "ch",
  ш: "sh",
  щ: "sch",
  ъ: "",
  ы: "y",
  ь: "",
  э: "e",
  ю: "yu",
  я: "ya",
};

/** ASCII slug for resource names (transliterates Cyrillic, drops the rest). */
export function slugify(s: string, maxLen = 40): string {
  const lower = (s || "").toLowerCase().normalize("NFD")
    .replace(/\p{M}/gu, "");
  let out = "";
  for (const ch of lower) {
    if (/[a-z0-9]/.test(ch)) out += ch;
    else if (ch in CYR_TRANSLIT) out += CYR_TRANSLIT[ch];
    else out += "-";
  }
  out = out.replace(/-+/g, "-").replace(/^-|-$/g, "");
  return out.slice(0, maxLen).replace(/-$/, "") || "x";
}

/** FNV-1a 32-bit hash as 8 hex chars — stable resource-name suffix. */
export function hash8(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

// --- Directory / filename parsing (fallback for missing tags) ---

const YEAR_RE = /(?:19|20)\d{2}/;

const DISC_DIR_RE = /^(?:cd|disc|disk|part|vol(?:ume)?)[\s._-]*(\d{1,2})$/i;

// isNoiseGroup lives in ../lib/norm.ts (pure domain logic, shared with
// normDupeKey and the wanted-derivation pipeline); imported above.

function stripNoise(s: string): string {
  let out = s;
  let prev = "";
  while (prev !== out) {
    prev = out;
    // bracket groups made entirely of quality/release noise
    out = out.replace(/[([{]([^()[\]{}]*)[)\]}]/g, (m, content) => {
      if (YEAR_RE.test(content) && content.trim().length <= 4) return m;
      return isNoiseGroup(content) ? " " : m;
    });
    // trailing bare quality tokens
    out = out.replace(
      /[\s\-_.]+(?:flac|ape|wav|mp3|320|256|192|128|vbr|cbr|lossless|web)$/i,
      "",
    );
    out = out.replace(/\s{2,}/g, " ").trim().replace(/[\s\-_,.]+$/, "").trim();
  }
  return out;
}

/**
 * Parse an album directory segment into { artist, album, year }.
 * Handles: "1983. Artist - Album (2013) [24-96]", "Artist - Album (2020)",
 * "1996 - Album", "1998 Album", "2008, [Artist] Album (CD, Album)",
 * "NN Artist - (Year)", "(catalog) Artist - Album", year ranges.
 */
export function parseAlbumDir(segment: string) {
  let s = segment.replace(/_/g, " ").trim();
  let year: number | null = null;

  // year range "(2004-2011)" → discography; keep first year, strip the group
  const range = s.match(/[([]?((?:19|20)\d{2})\s?[-–—]\s?(?:19|20)\d{2}[)\]]?/);
  if (range) {
    year = parseInt(range[1], 10);
    s = s.replace(range[0], " ");
  }

  // leading year: "1983. X", "1996 - X", "1998 X", "2008, X"
  const lead = s.match(/^((?:19|20)\d{2})\s*[.,\-–—_]?\s+(\S.*)$/);
  if (lead) {
    year = year ?? parseInt(lead[1], 10);
    s = lead[2];
  }

  // parenthesised/trailing year (only if not already found)
  const paren = s.match(/[([]((?:19|20)\d{2})[)\]]/) ||
    s.match(/[\s\-_.]((?:19|20)\d{2})$/);
  if (paren) {
    if (year === null) year = parseInt(paren[1], 10);
    s = s.replace(paren[0], " ");
  }

  s = stripNoise(s);

  // leading collection index "01 House Of Pain" (max 2 digits)
  s = s.replace(/^\d{1,2}[\s.\-_]+(?=\S)/, "");

  // leading throwaway paren group before "Artist - Album"
  s = s.replace(/^\([^)]{1,30}\)\s+(?=\S.*\s[-–—]\s)/, "").trim();

  let artist: string | null = null;
  let album: string | null = null;

  // "[Artist] Album"
  const bracketArtist = s.match(/^\[([^\]]{2,60})\]\s+(\S.*)$/);
  if (bracketArtist) {
    artist = bracketArtist[1].trim();
    album = stripNoise(bracketArtist[2]);
  } else {
    const parts = s.split(/\s+[-–—]\s+/).map((p) => p.trim()).filter((p) =>
      p.length > 0
    );
    if (parts.length >= 2) {
      artist = parts[0];
      album = parts.slice(1).join(" - ");
    } else {
      album = s || null;
    }
  }

  if (album) album = stripNoise(album) || null;
  if (artist) artist = stripNoise(artist) || null;
  return { artist, album, year };
}

/**
 * Parse a track filename (without extension) into
 * { trackNo, title, artist, dosMangled }.
 */
export function parseTrackFilename(name: string, knownArtist?: string | null) {
  const dosMangled = /~\d/.test(name);
  let s = name.replace(/_/g, " ").trim();
  let trackNo: number | null = null;
  let artist: string | null = null;
  let title: string | null = null;

  // "Artist - NN - Title"
  const anT = s.match(/^(.+?)\s+-\s+(\d{1,3})\s+-\s+(.+)$/);
  if (anT && !YEAR_RE.test(anT[2])) {
    artist = anT[1].trim();
    trackNo = parseInt(anT[2], 10);
    title = anT[3].trim();
    return { trackNo, title, artist, dosMangled };
  }

  // "NN - Title", "NN. Title", "NN Title", "NN-Title"
  const nT = s.match(/^(\d{1,3})[\s.\-_]+(\S.*)$/);
  if (nT && nT[1].length <= 3) {
    trackNo = parseInt(nT[1], 10);
    s = nT[2].trim();
  }

  // "Artist - Title" (only useful when the artist half matches or is missing)
  const aT = s.match(/^(.+?)\s+-\s+(.+)$/);
  if (aT) {
    const left = aT[1].trim();
    if (
      knownArtist &&
      left.toLowerCase() === String(knownArtist).toLowerCase()
    ) {
      title = aT[2].trim();
    } else if (!knownArtist && trackNo === null) {
      artist = left;
      title = aT[2].trim();
    } else {
      title = s;
    }
  } else {
    title = s;
  }

  return { trackNo, title: title || null, artist, dosMangled };
}

// --- Cube construction (pure — unit-testable) ---

/** Row shape produced by TRACKS_SQL against gonic.db. */
export type GonicRow = {
  id: number;
  filename: string;
  tag_title: string | null;
  tag_track_artist: string | null;
  track_number: number | null;
  disc_number: number | null;
  tag_year: number | null;
  length: number | null;
  bitrate: number | null;
  size: number | null;
  left_path: string | null;
  right_path: string;
  album_title: string | null;
  album_artist: string | null;
  album_year: number | null;
  compilation: number | null;
};

type EncodingFix = {
  path: string;
  field: string;
  before: string;
  after: string;
  encoding: string | null;
};

type TrackRec = {
  file: string;
  title: string | null;
  artist: string | null;
  trackNo: number | null;
  discNo: number | null;
  year: number | null;
  genres: string[];
  format: string;
  durationSec: number | null;
  bitrateKbps: number | null;
  sizeBytes: number | null;
  source: string;
  fallbackFields: string[];
  fixedFields: string[];
};

type DirParsed = {
  artist: string | null;
  album: string | null;
  year: number | null;
};

type AlbumGroup = {
  dir: string;
  tagAlbum: string | null;
  tagAlbumArtist: string | null;
  albumYear: number | null;
  compilation: boolean;
  dirParsed: DirParsed;
  parentArtist: string | null;
  tracks: TrackRec[];
};

type AlbumRec = {
  kind: "album";
  key: string;
  dir: string;
  title: string | null;
  artist: string | null;
  albumArtist: string | null;
  compilation: boolean;
  year: number | null;
  genres: string[];
  formats: string[];
  discCount: number;
  trackCount: number;
  durationSec: number;
  sizeBytes: number;
  source: string;
  encodingFixedTracks: number;
  untaggedTracks: number;
  tracks: TrackRec[];
};

type ArtistAlbumRef = {
  key: string;
  title: string | null;
  year: number | null;
  trackCount: number;
};

type ArtistRec = {
  kind: "artist";
  key: string;
  name: string;
  variants: string[];
  albumCount: number;
  trackCount: number;
  durationSec: number;
  genres: string[];
  formats: string[];
  yearFrom: number | null;
  yearTo: number | null;
  albums: ArtistAlbumRef[];
};

type ArtistGroup = {
  names: Map<string, number>;
  albums: Map<string, ArtistAlbumRef>;
  trackCount: number;
  durationSec: number;
  genres: Set<string>;
  formats: Set<string>;
  years: number[];
};

const AUDIO_LOSSLESS = new Set(["flac", "ape", "wav", "alac", "wv", "aiff"]);

function qualityBucket(format: string, bitrate: number | null): string {
  if (AUDIO_LOSSLESS.has(format)) return "lossless";
  if (!bitrate) return "unknown";
  if (bitrate >= 256) return "lossy-high";
  if (bitrate >= 160) return "lossy-mid";
  return "lossy-low";
}

function fixField(
  raw: unknown,
  fixes: EncodingFix[],
  path: string,
  field: string,
  allowed?: Set<string>,
): string | null {
  if (raw === null || raw === undefined || raw === "") return null;
  const r = fixEncoding(String(raw), 0, allowed);
  if (r.fixed) {
    fixes.push({
      path,
      field,
      before: String(raw),
      after: r.value,
      encoding: r.encoding,
    });
  }
  return isPlaceholder(r.value) ? null : r.value;
}

function normArtistKey(name: string | null): string {
  return (name || "unknown").toLowerCase().replace(/^the\s+/, "")
    .replace(/\s+/g, " ").trim();
}

/**
 * Build the multidimensional cube from raw gonic rows.
 * rows: joined track+album rows; genresByTrack: trackId → string[].
 * Returns { albums, artists, dims, issues, summary } (plain objects, no IO).
 */
export function buildCube(
  rows: GonicRow[],
  genresByTrack: Map<number, string[]>,
  opts: {
    pathPrefix?: string;
    maxAlbums?: number;
    legacyEncodings?: string[];
  } = {},
) {
  const allowed = new Set(opts.legacyEncodings ?? DEFAULT_LEGACY_ENCODINGS);
  const fixes: EncodingFix[] = [];
  const untagged: { path: string; missing: string[] }[] = [];
  const dosMangled: string[] = [];
  const albumGroups = new Map<string, AlbumGroup>();

  for (const row of rows) {
    const leftPath = row.left_path || "";
    const rightPath = row.right_path || "";
    const filename = row.filename || "";
    let relDir = leftPath + rightPath;
    const relPath = relDir + "/" + filename;

    if (opts.pathPrefix && !relPath.startsWith(opts.pathPrefix)) continue;

    // Disc subdirectory → group under the parent album dir
    let discFromDir: number | null = null;
    const discMatch = rightPath.match(DISC_DIR_RE);
    if (discMatch && leftPath) {
      discFromDir = parseInt(discMatch[1], 10);
      relDir = leftPath.replace(/\/$/, "");
    }

    const ext = (filename.match(/\.([A-Za-z0-9]+)$/) || [, ""])[1]
      .toLowerCase();
    const baseName = filename.replace(/\.[A-Za-z0-9]+$/, "");
    const fixStart = fixes.length;

    // encoding-recovered, placeholder-free tag values
    const tagTitle = fixField(
      row.tag_title,
      fixes,
      relPath,
      "title",
      allowed,
    );
    const tagArtist = fixField(
      row.tag_track_artist,
      fixes,
      relPath,
      "artist",
      allowed,
    );
    const tagAlbum = fixField(
      row.album_title,
      fixes,
      relPath,
      "album",
      allowed,
    );
    const tagAlbumArtist = fixField(
      row.album_artist,
      fixes,
      relPath,
      "albumArtist",
      allowed,
    );
    const genresRaw = genresByTrack.get(row.id) || [];
    const genres: string[] = [];
    for (const g of genresRaw) {
      const fg = fixField(g, fixes, relPath, "genre", allowed);
      if (fg) genres.push(fg);
    }

    // directory naming fallback
    const dirSegments = relDir.split("/").filter((p) => p.length > 0);
    const leafSeg =
      fixEncoding(dirSegments[dirSegments.length - 1] || "", 0, allowed).value;
    const parentSeg =
      fixEncoding(dirSegments[dirSegments.length - 2] || "", 0, allowed).value;
    const dirParsed = parseAlbumDir(leafSeg);
    // parent dir as artist candidate: strip "NN " collection index
    const parentArtist = parentSeg
      ? stripNoise(parentSeg.replace(/^\d{1,2}[\s.\-_]+(?=\S)/, ""))
      : null;
    const fileParsed = parseTrackFilename(
      fixEncoding(baseName, 0, allowed).value,
      tagArtist || dirParsed.artist || parentArtist,
    );
    if (fileParsed.dosMangled) dosMangled.push(relPath);

    const fallbackFields: string[] = [];
    const pick = <T>(
      tagVal: T | null | undefined,
      fallbackVal: T | null | undefined,
      field: string,
    ): T | null => {
      if (tagVal !== null && tagVal !== undefined) return tagVal;
      if (fallbackVal !== null && fallbackVal !== undefined) {
        fallbackFields.push(field);
        return fallbackVal;
      }
      return null;
    };

    const title = pick(tagTitle, fileParsed.title, "title");
    const artist = pick(
      tagArtist,
      fileParsed.artist || dirParsed.artist || parentArtist,
      "artist",
    );
    const album = pick(tagAlbum, dirParsed.album || leafSeg || null, "album");
    const year = pick(
      row.tag_year || row.album_year || null,
      dirParsed.year,
      "year",
    );
    const trackNo = pick(
      row.track_number || null,
      fileParsed.trackNo,
      "trackNo",
    );
    const discNo = pick(row.disc_number || null, discFromDir, "discNo");

    const tagFieldCount = [tagTitle, tagArtist, tagAlbum]
      .filter((v) => v !== null).length;
    const source = tagFieldCount === 3
      ? "tags"
      : tagFieldCount === 0
      ? (fallbackFields.length > 0 ? "dirname" : "none")
      : "mixed";

    const missing: string[] = [];
    if (!title) missing.push("title");
    if (!artist) missing.push("artist");
    if (!album) missing.push("album");
    if (missing.length > 0) untagged.push({ path: relPath, missing });

    const track: TrackRec = {
      file: filename,
      title,
      artist,
      trackNo,
      discNo,
      year,
      genres,
      format: ext,
      durationSec: row.length ?? null,
      bitrateKbps: row.bitrate ?? null,
      sizeBytes: row.size ?? null,
      source,
      fallbackFields,
      fixedFields: [...new Set(fixes.slice(fixStart).map((f) => f.field))],
    };

    if (!albumGroups.has(relDir)) {
      albumGroups.set(relDir, {
        dir: relDir,
        tagAlbum,
        tagAlbumArtist,
        albumYear: row.album_year || null,
        compilation: row.compilation === 1,
        dirParsed,
        parentArtist,
        tracks: [],
      });
    }
    const group = albumGroups.get(relDir)!;
    group.tracks.push(track);
    if (!group.tagAlbum && tagAlbum) group.tagAlbum = tagAlbum;
    if (!group.tagAlbumArtist && tagAlbumArtist) {
      group.tagAlbumArtist = tagAlbumArtist;
    }
  }

  // --- album facts ---
  let albums: AlbumRec[] = [];
  for (const g of albumGroups.values()) {
    const trackArtists = [
      ...new Set(g.tracks.map((t) => t.artist).filter((a) => a)),
    ];
    const artist = g.tagAlbumArtist ??
      (trackArtists.length === 1
        ? trackArtists[0]
        : trackArtists.length > 1
        ? "Various Artists"
        : (g.dirParsed.artist || g.parentArtist || null));
    const years = [
      ...new Set(g.tracks.map((t) => t.year).filter((y) => y)),
    ];
    const genres = [...new Set(g.tracks.flatMap((t) => t.genres))];
    const formats = [...new Set(g.tracks.map((t) => t.format))];
    const discs = [
      ...new Set(g.tracks.map((t) => t.discNo).filter((d) => d)),
    ];
    const sources = new Set(g.tracks.map((t) => t.source));
    const title = g.tagAlbum || g.dirParsed.album || null;
    const key = `album-${slugify(title || g.dir)}-${hash8(g.dir)}`;
    albums.push({
      kind: "album",
      key,
      dir: g.dir,
      title,
      artist,
      albumArtist: g.tagAlbumArtist,
      compilation: g.compilation || trackArtists.length > 3,
      year: g.albumYear ?? g.dirParsed.year ?? (years[0] || null),
      genres,
      formats,
      discCount: Math.max(discs.length, 1),
      trackCount: g.tracks.length,
      durationSec: g.tracks.reduce((a, t) => a + (t.durationSec || 0), 0),
      sizeBytes: g.tracks.reduce((a, t) => a + (t.sizeBytes || 0), 0),
      source: sources.size === 1 ? [...sources][0] : "mixed",
      encodingFixedTracks: g.tracks.filter((t) =>
        t.fixedFields.length > 0
      ).length,
      untaggedTracks: g.tracks.filter((t) => t.source === "none").length,
      tracks: g.tracks,
    });
  }
  albums.sort((a, b) => a.dir.localeCompare(b.dir));
  let keptDirs: Set<string> | null = null;
  if (opts.maxAlbums && opts.maxAlbums > 0) {
    albums = albums.slice(0, opts.maxAlbums);
    keptDirs = new Set(albums.map((a) => a.dir));
  }
  // A path belongs to a kept album when its dir (or, for disc subdirs, the
  // dir's parent) is in the kept set.
  const inKept = (path: string) => {
    if (!keptDirs) return true;
    const dir = path.slice(0, path.lastIndexOf("/"));
    if (keptDirs.has(dir)) return true;
    return keptDirs.has(dir.slice(0, dir.lastIndexOf("/")));
  };

  // --- artist dimension ---
  const artistGroups = new Map<string, ArtistGroup>();
  for (const alb of albums) {
    for (const t of alb.tracks) {
      const name = t.artist || "Unknown Artist";
      const k = normArtistKey(name);
      if (!artistGroups.has(k)) {
        artistGroups.set(k, {
          names: new Map(),
          albums: new Map(),
          trackCount: 0,
          durationSec: 0,
          genres: new Set(),
          formats: new Set(),
          years: [],
        });
      }
      const a = artistGroups.get(k)!;
      a.names.set(name, (a.names.get(name) || 0) + 1);
      a.trackCount += 1;
      a.durationSec += t.durationSec || 0;
      for (const gname of t.genres) a.genres.add(gname);
      a.formats.add(t.format);
      if (t.year) a.years.push(t.year);
      if (!a.albums.has(alb.key)) {
        a.albums.set(alb.key, {
          key: alb.key,
          title: alb.title,
          year: alb.year,
          trackCount: 0,
        });
      }
      a.albums.get(alb.key)!.trackCount += 1;
    }
  }
  const artists: ArtistRec[] = [];
  for (const [k, a] of artistGroups.entries()) {
    const canonical = [...a.names.entries()].sort((x, y) => y[1] - x[1])[0][0];
    artists.push({
      kind: "artist",
      key: `artist-${slugify(canonical)}-${hash8(k)}`,
      name: canonical,
      variants: [...a.names.keys()].filter((n) => n !== canonical),
      albumCount: a.albums.size,
      trackCount: a.trackCount,
      durationSec: a.durationSec,
      genres: [...a.genres],
      formats: [...a.formats],
      yearFrom: a.years.length ? Math.min(...a.years) : null,
      yearTo: a.years.length ? Math.max(...a.years) : null,
      albums: [...a.albums.values()].sort((x, y) =>
        (x.year || 0) - (y.year || 0)
      ),
    });
  }
  artists.sort((a, b) => b.trackCount - a.trackCount);

  // --- rollup dimensions ---
  const genreMap = new Map<
    string,
    {
      genre: string;
      trackCount: number;
      albums: Set<string>;
      artists: Set<string>;
    }
  >();
  const yearMap = new Map<number, number>();
  const decadeMap = new Map<number, number>();
  const formatMap = new Map<
    string,
    {
      format: string;
      trackCount: number;
      sizeBytes: number;
      durationSec: number;
      bitrateSum: number;
      bitrateN: number;
    }
  >();
  const qualityMap = new Map<
    string,
    { bucket: string; trackCount: number; sizeBytes: number }
  >();
  let unknownYearTracks = 0;

  for (const alb of albums) {
    for (const t of alb.tracks) {
      for (const gname of (t.genres.length ? t.genres : ["(none)"])) {
        if (!genreMap.has(gname)) {
          genreMap.set(gname, {
            genre: gname,
            trackCount: 0,
            albums: new Set(),
            artists: new Set(),
          });
        }
        const ge = genreMap.get(gname)!;
        ge.trackCount += 1;
        ge.albums.add(alb.key);
        if (t.artist) ge.artists.add(normArtistKey(t.artist));
      }
      if (t.year) {
        yearMap.set(t.year, (yearMap.get(t.year) || 0) + 1);
        const dec = Math.floor(t.year / 10) * 10;
        decadeMap.set(dec, (decadeMap.get(dec) || 0) + 1);
      } else unknownYearTracks += 1;
      if (!formatMap.has(t.format)) {
        formatMap.set(t.format, {
          format: t.format,
          trackCount: 0,
          sizeBytes: 0,
          durationSec: 0,
          bitrateSum: 0,
          bitrateN: 0,
        });
      }
      const fe = formatMap.get(t.format)!;
      fe.trackCount += 1;
      fe.sizeBytes += t.sizeBytes || 0;
      fe.durationSec += t.durationSec || 0;
      if (t.bitrateKbps) {
        fe.bitrateSum += t.bitrateKbps;
        fe.bitrateN += 1;
      }
      const qb = qualityBucket(t.format, t.bitrateKbps);
      if (!qualityMap.has(qb)) {
        qualityMap.set(qb, { bucket: qb, trackCount: 0, sizeBytes: 0 });
      }
      const qe = qualityMap.get(qb)!;
      qe.trackCount += 1;
      qe.sizeBytes += t.sizeBytes || 0;
    }
  }

  const dims = {
    genres: [...genreMap.values()]
      .map((g) => ({
        genre: g.genre,
        trackCount: g.trackCount,
        albumCount: g.albums.size,
        artistCount: g.artists.size,
      }))
      .sort((a, b) => b.trackCount - a.trackCount),
    years: {
      years: [...yearMap.entries()]
        .map(([year, trackCount]) => ({ year, trackCount }))
        .sort((a, b) => a.year - b.year),
      decades: [...decadeMap.entries()]
        .map(([decade, trackCount]) => ({ decade, trackCount }))
        .sort((a, b) => a.decade - b.decade),
      unknownYearTracks,
    },
    formats: [...formatMap.values()]
      .map((f) => ({
        format: f.format,
        trackCount: f.trackCount,
        sizeBytes: f.sizeBytes,
        durationSec: f.durationSec,
        avgBitrateKbps: f.bitrateN
          ? Math.round(f.bitrateSum / f.bitrateN)
          : null,
      }))
      .sort((a, b) => b.trackCount - a.trackCount),
    quality: [...qualityMap.values()].sort((a, b) =>
      b.trackCount - a.trackCount
    ),
  };

  const dirnameOnlyAlbums = albums
    .filter((a) => a.source === "dirname")
    .map((a) => ({ key: a.key, dir: a.dir }));

  const issues = {
    untagged: untagged.filter((u) => inKept(u.path)),
    dirnameOnlyAlbums,
    encodingFixes: fixes.filter((f) => inKept(f.path)),
    dosMangledNames: [...new Set(dosMangled)].filter(inKept),
  };

  const trackTotal = albums.reduce((a, alb) => a + alb.trackCount, 0);
  const summary = {
    kind: "library",
    totals: {
      tracks: trackTotal,
      albums: albums.length,
      artists: artists.length,
      genres: dims.genres.length,
      durationSec: albums.reduce((a, alb) => a + alb.durationSec, 0),
      sizeBytes: albums.reduce((a, alb) => a + alb.sizeBytes, 0),
    },
    sources: { tags: 0, mixed: 0, dirname: 0, none: 0 } as Record<
      string,
      number
    >,
    encodingFixedTracks: new Set(fixes.map((f) => f.path)).size,
    untaggedTracks: untagged.length,
    dosMangledNames: issues.dosMangledNames.length,
    formats: Object.fromEntries(
      dims.formats.map((f) => [f.format, f.trackCount]),
    ),
  };
  for (const alb of albums) {
    for (const t of alb.tracks) summary.sources[t.source] += 1;
  }

  return { albums, artists, dims, issues, summary };
}

// --- Duplicate detection (pure — unit-testable) ---

// normDupeKey lives in ../lib/norm.ts (pure domain logic, imported above);
// re-exported here so existing importers of music_library.ts keep working
// unchanged.
export { normDupeKey } from "../lib/norm.ts";

type DupeAlbumEntry = {
  key: string;
  dir: string;
  formats: string[];
  trackCount: number;
  sizeBytes: number;
  avgBitrateKbps: number | null;
  qualityRank: number;
  compilation: boolean;
};

type AlbumDupeCluster = {
  artist: string;
  title: string;
  albums: DupeAlbumEntry[];
  keep: string;
  reclaimableBytes: number;
};

type TrackDupeRef = {
  path: string;
  albumKey: string;
  format: string;
  bitrateKbps: number | null;
  durationSec: number | null;
  sizeBytes: number | null;
};

type TrackDupeCluster = {
  artist: string;
  title: string;
  durationSec: number | null;
  count: number;
  acrossAlbums: boolean;
  tracks: TrackDupeRef[];
};

function albumQualityRank(alb: AlbumRec): number {
  const lossless =
    alb.tracks.filter((t) => AUDIO_LOSSLESS.has(t.format)).length;
  if (alb.trackCount > 0 && lossless / alb.trackCount >= 0.5) return 3;
  const rates = alb.tracks.map((t) => t.bitrateKbps || 0);
  const avg = rates.length
    ? rates.reduce((a, b) => a + b, 0) / rates.length
    : 0;
  if (avg >= 256) return 2;
  if (avg >= 160) return 1;
  return 0;
}

/**
 * Find duplicate albums (same normalized artist+title in different
 * directories) and duplicate tracks (same normalized artist+title with
 * near-equal duration). Pure function over album facts.
 */
export function findDupes(albums: AlbumRec[]) {
  // --- album clusters ---
  const byAlbum = new Map<
    string,
    { artist: string; title: string; albums: { alb: AlbumRec; rank: number }[] }
  >();
  for (const alb of albums) {
    if (!alb.artist || !alb.title) continue;
    const k = `${normDupeKey(alb.artist)}|${normDupeKey(alb.title)}`;
    if (!normDupeKey(alb.title)) continue;
    if (!byAlbum.has(k)) {
      byAlbum.set(k, { artist: alb.artist, title: alb.title, albums: [] });
    }
    byAlbum.get(k)!.albums.push({ alb, rank: albumQualityRank(alb) });
  }
  const albumClusters: AlbumDupeCluster[] = [];
  for (const g of byAlbum.values()) {
    if (g.albums.length < 2) continue;
    // Sibling subdirs of one release (box-set discs, 5.1/stereo mixes)
    // share a parent dir and are intentional variants, not duplicates:
    // keep only the best entry per parent. Root-level dirs are their own
    // group so two root rips still cluster.
    const byParent = new Map<string, { alb: AlbumRec; rank: number }>();
    for (const e of g.albums) {
      const cut = e.alb.dir.lastIndexOf("/");
      const parent = cut > 0 ? e.alb.dir.slice(0, cut) : e.alb.dir;
      const cur = byParent.get(parent);
      if (
        !cur ||
        e.rank > cur.rank ||
        (e.rank === cur.rank && e.alb.trackCount > cur.alb.trackCount)
      ) {
        byParent.set(parent, e);
      }
    }
    if (byParent.size < 2) continue;
    // keep the best: quality rank, then track count, then size
    const sorted = [...byParent.values()].sort((a, b) =>
      b.rank - a.rank || b.alb.trackCount - a.alb.trackCount ||
      b.alb.sizeBytes - a.alb.sizeBytes
    );
    const keep = sorted[0].alb;
    albumClusters.push({
      artist: g.artist,
      title: g.title,
      albums: sorted.map(({ alb, rank }) => ({
        key: alb.key,
        dir: alb.dir,
        formats: alb.formats,
        trackCount: alb.trackCount,
        sizeBytes: alb.sizeBytes,
        avgBitrateKbps: (() => {
          const rs = alb.tracks.map((t) => t.bitrateKbps || 0).filter((r) => r);
          return rs.length
            ? Math.round(rs.reduce((a, b) => a + b, 0) / rs.length)
            : null;
        })(),
        qualityRank: rank,
        compilation: alb.compilation,
      })),
      keep: keep.dir,
      reclaimableBytes: sorted.slice(1).reduce(
        (a, e) => a + e.alb.sizeBytes,
        0,
      ),
    });
  }
  albumClusters.sort((a, b) => b.reclaimableBytes - a.reclaimableBytes);

  // --- track clusters ---
  const byTrack = new Map<
    string,
    { artist: string; title: string; refs: TrackDupeRef[] }
  >();
  for (const alb of albums) {
    for (const t of alb.tracks) {
      if (!t.artist || !t.title) continue;
      const k = `${normDupeKey(t.artist)}|${normDupeKey(t.title)}`;
      if (k.endsWith("|")) continue;
      if (!byTrack.has(k)) {
        byTrack.set(k, { artist: t.artist, title: t.title, refs: [] });
      }
      byTrack.get(k)!.refs.push({
        path: alb.dir + "/" + t.file,
        albumKey: alb.key,
        format: t.format,
        bitrateKbps: t.bitrateKbps,
        durationSec: t.durationSec,
        sizeBytes: t.sizeBytes,
      });
    }
  }
  const trackClusters: TrackDupeCluster[] = [];
  for (const g of byTrack.values()) {
    if (g.refs.length < 2) continue;
    // subgroup by near-equal duration (±5 s) so live/extended versions of
    // the same song do not count as duplicates
    const sorted = [...g.refs].sort(
      (a, b) => (a.durationSec ?? -1) - (b.durationSec ?? -1),
    );
    let start = 0;
    for (let i = 1; i <= sorted.length; i++) {
      const gap = i < sorted.length
        ? (sorted[i].durationSec ?? -1) - (sorted[i - 1].durationSec ?? -1)
        : Infinity;
      if (gap > 5) {
        const sub = sorted.slice(start, i);
        if (sub.length >= 2) {
          trackClusters.push({
            artist: g.artist,
            title: g.title,
            durationSec: sub[0].durationSec,
            count: sub.length,
            acrossAlbums: new Set(sub.map((r) => r.albumKey)).size > 1,
            tracks: sub,
          });
        }
        start = i;
      }
    }
  }
  trackClusters.sort((a, b) => b.count - a.count);

  return { albumClusters, trackClusters };
}

// --- Playback verification (pure helpers — unit-testable) ---

// ffmpeg -stats progress lines; everything else on stderr is an error.
const FFMPEG_PROGRESS_RE = /^\s*(size=|frame=|video:|audio:|\[out#)/;
const FFMPEG_TIME_RE = /time=(\d+):(\d{2}):(\d{2}(?:\.\d+)?)/g;

/**
 * Split captured `ffmpeg -v error -stats` output into decode-error lines
 * and the last reported decode position (seconds).
 */
export function parseFfmpegVerifyOutput(raw: string): {
  decodedSec: number | null;
  errorLines: string[];
} {
  let decodedSec: number | null = null;
  for (const m of raw.matchAll(FFMPEG_TIME_RE)) {
    const sec = parseInt(m[1], 10) * 3600 + parseInt(m[2], 10) * 60 +
      parseFloat(m[3]);
    decodedSec = Math.round(sec * 100) / 100;
  }
  const errorLines = raw
    .split("\n")
    .map((l) => l.trim())
    .filter((l) =>
      l.length > 0 && !FFMPEG_PROGRESS_RE.test(l) && !l.includes("time=")
    )
    .slice(0, 20);
  return { decodedSec, errorLines };
}

/**
 * Verdict for one file: `failed` (ffmpeg could not decode), `errors`
 * (decoded with corruption reports), `truncated` (full decode ended well
 * short of the expected duration), or `ok`.
 */
export function classifyVerify(
  rc: number,
  errorLines: string[],
  expectedSec: number | null,
  decodedSec: number | null,
  mode: string,
  tailSec = 15,
): string {
  if (rc !== 0) return "failed";
  if (errorLines.length > 0) return "errors";
  if (
    mode === "full" && expectedSec !== null && expectedSec > 0 &&
    decodedSec !== null && expectedSec - decodedSec > 2.5
  ) {
    return "truncated";
  }
  // quick mode seeks to (expected - tail): a healthy file decodes ≈ tail
  // seconds; decoding far less (or nothing) means the file ends early.
  // The /2 slack absorbs VBR header duration estimates being a bit off.
  if (
    mode === "quick" && expectedSec !== null && expectedSec > tailSec &&
    (decodedSec === null || decodedSec < tailSec / 2)
  ) {
    return "truncated";
  }
  return "ok";
}

type VerifyProblem = {
  path: string;
  status: string;
  rc: number;
  expectedSec: number | null;
  decodedSec: number | null;
  errors: string[];
};

// --- Tempo analysis (bpm) ---

// Runs inside the essentia image (python bindings, no ffmpeg/jq there). Reads
// one file path per line on stdin, writes one compact JSON record per line.
//
// Decoding once and feeding the same buffer to every algorithm is the whole
// point: the essentia CLI extractors each re-decode the file, which costs more
// than the analysis. RhythmExtractor2013 also yields a real beat-detection
// confidence, which the `essentia_streaming_extractor_music` JSON does not
// expose — and that number is what separates a track with an actual beat from
// one where the tracker merely imposed an even grid.
const ANALYZE_PY = `
import json, math, signal, sys, time
import essentia, essentia.standard as es

essentia.log.infoActive = False
essentia.log.warningActive = False
SR = 44100

class Timeout(Exception):
    pass

def _alarm(signum, frame):
    raise Timeout("analysis exceeded per-file timeout")

signal.signal(signal.SIGALRM, _alarm)

def analyze(path, window_sec, start_frac):
    t0 = time.time()
    out = {"path": path}
    audio = es.MonoLoader(filename=path, sampleRate=SR)()
    total = len(audio) / float(SR)
    out["lengthSec"] = round(total, 2)
    windowed = False
    if window_sec > 0 and total > window_sec:
        start = max(0.0, (total - window_sec) * start_frac)
        a = int(start * SR)
        audio = audio[a:a + int(window_sec * SR)]
        windowed = True
    out["windowed"] = windowed
    out["analyzedSec"] = round(len(audio) / float(SR), 2)
    if out["analyzedSec"] < 10:
        raise ValueError("too short to analyze: %.2fs" % out["analyzedSec"])

    bpm, ticks, conf, estimates, intervals = es.RhythmExtractor2013(
        method="multifeature")(audio)
    out["bpm"] = round(float(bpm), 2)
    out["beatsConfidence"] = round(float(conf), 4)
    out["beatsCount"] = int(len(ticks))

    iv = [float(x) for x in intervals]
    if len(iv) > 2:
        mean = sum(iv) / len(iv)
        var = sum((x - mean) ** 2 for x in iv) / len(iv)
        out["ibiCv"] = round(math.sqrt(var) / mean if mean else 0.0, 4)
    est = [float(x) for x in estimates]
    if est:
        em = sum(est) / len(est)
        ev = sum((x - em) ** 2 for x in est) / len(est)
        out["estStd"] = round(math.sqrt(ev), 3)

    key, scale, strength = es.KeyExtractor()(audio)
    out["key"] = key
    out["scale"] = scale
    out["keyStrength"] = round(float(strength), 4)
    out["danceability"] = round(float(es.Danceability()(audio)[0]), 4)
    out["ms"] = int((time.time() - t0) * 1000)
    return out

win = float(sys.argv[1])
frac = float(sys.argv[2])
timeout = int(sys.argv[3]) if len(sys.argv) > 3 else 240
for line in sys.stdin:
    p = line.rstrip("\\n")
    if not p:
        continue
    try:
        # A gonic length of 0/unknown lets a genuinely huge file slip past the
        # host-side maxLengthSec skip; without this a single such file decodes
        # for hours and, at concurrency 1, hangs the whole batch. On timeout we
        # emit a failure so the file is recorded and never retried.
        if timeout > 0:
            signal.alarm(timeout)
        rec = analyze(p, win, frac)
        rec["rc"] = 0
    except Timeout as e:
        rec = {"path": p, "rc": 2, "err": str(e)}
    except Exception as e:
        rec = {"path": p, "rc": 1, "err": str(e)[:300]}
    finally:
        signal.alarm(0)
    sys.stdout.write(json.dumps(rec, separators=(",", ":")) + "\\n")
    sys.stdout.flush()
`;

/**
 * Band for essentia's RhythmExtractor2013 beat-detection confidence, whose
 * documented range is 0–5.32. Low bands mean the tracker could not find a
 * convincing beat (rubato ballads, ambient, solo classical) — the reported bpm
 * for those is a grid it imposed, not a pulse you could run to.
 */
export function bpmConfidenceBand(conf: number | null | undefined): string {
  if (conf === null || conf === undefined || !Number.isFinite(conf)) {
    return "unknown";
  }
  if (conf === 0) return "none";
  if (conf < 1) return "very-low";
  if (conf < 1.5) return "low";
  if (conf < 3.5) return "good";
  return "excellent";
}

type BpmTrack = {
  path: string;
  bpm: number | null;
  beatsConfidence: number | null;
  confidenceBand: string;
  beatsCount: number | null;
  ibiCv: number | null;
  estStd: number | null;
  key: string | null;
  scale: string | null;
  keyStrength: number | null;
  danceability: number | null;
  lengthSec: number | null;
  analyzedSec: number | null;
  windowed: boolean;
  ms: number | null;
};

type BpmFailure = { path: string; err: string };

/**
 * Parse one JSON record emitted by ANALYZE_PY into a track row or a failure.
 * Unparseable lines (essentia writes stray native warnings to stdout on some
 * files) are ignored rather than failing the whole batch.
 */
export function parseBpmLine(
  line: string,
  relOf: (containerPath: string) => string,
): { track?: BpmTrack; failure?: BpmFailure } {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) return {};
  let rec: Record<string, unknown>;
  try {
    rec = JSON.parse(trimmed);
  } catch {
    return {};
  }
  const path = typeof rec.path === "string" ? rec.path : null;
  if (!path) return {};
  const rel = relOf(path);
  if (rec.rc !== 0) {
    return {
      failure: {
        path: rel,
        err: String(rec.err ?? "unknown error").slice(0, 300),
      },
    };
  }
  const num = (v: unknown): number | null =>
    typeof v === "number" && Number.isFinite(v) ? v : null;
  const str = (v: unknown): string | null => typeof v === "string" ? v : null;
  const conf = num(rec.beatsConfidence);
  return {
    track: {
      path: rel,
      bpm: num(rec.bpm),
      beatsConfidence: conf,
      confidenceBand: bpmConfidenceBand(conf),
      beatsCount: num(rec.beatsCount),
      ibiCv: num(rec.ibiCv),
      estStd: num(rec.estStd),
      key: str(rec.key),
      scale: str(rec.scale),
      keyStrength: num(rec.keyStrength),
      danceability: num(rec.danceability),
      lengthSec: num(rec.lengthSec),
      analyzedSec: num(rec.analyzedSec),
      windowed: rec.windowed === true,
      ms: num(rec.ms),
    },
  };
}

/**
 * Name of the `bpm` resource covering a scope. The `running` method reads back
 * exactly what a matching `bpm` run wrote, so both must derive it identically.
 */
export function bpmResourceName(path: string, pathPrefix: string): string {
  if (path) {
    return `bpm-file-${slugify(path.split("/").pop() || path)}-${hash8(path)}`;
  }
  if (pathPrefix) {
    return `bpm-${slugify(pathPrefix)}-${hash8(pathPrefix)}`;
  }
  return "bpm-library";
}

/**
 * Statistical median of an ALREADY-SORTED-ASCENDING array of numbers; `null`
 * for an empty array. An even-length array averages the two middle values
 * rather than picking the upper of the two (bpms[Math.floor(n / 2)] is the
 * upper-middle value, not the median).
 */
export function median(sortedAscending: number[]): number | null {
  const n = sortedAscending.length;
  if (n === 0) return null;
  const mid = n >> 1;
  return n % 2 === 1
    ? sortedAscending[mid]
    : (sortedAscending[mid - 1] + sortedAscending[mid]) / 2;
}

/** Distribution of analyzed tracks across 10-bpm buckets. */
export function bpmHistogram(tracks: BpmTrack[]): Record<string, number> {
  const hist: Record<string, number> = {};
  for (const t of tracks) {
    if (t.bpm === null) continue;
    const lo = Math.floor(t.bpm / 10) * 10;
    const key = `${lo}-${lo + 10}`;
    hist[key] = (hist[key] ?? 0) + 1;
  }
  return hist;
}

// --- Resource schemas ---

const TrackSchema = z.object({
  file: z.string(),
  title: z.string().nullable(),
  artist: z.string().nullable(),
  trackNo: z.number().nullable(),
  discNo: z.number().nullable(),
  year: z.number().nullable(),
  genres: z.array(z.string()),
  format: z.string(),
  durationSec: z.number().nullable(),
  bitrateKbps: z.number().nullable(),
  sizeBytes: z.number().nullable(),
  source: z.string(),
  fallbackFields: z.array(z.string()),
  fixedFields: z.array(z.string()),
});

const AlbumSchema = z.object({
  kind: z.literal("album"),
  key: z.string(),
  dir: z.string(),
  title: z.string().nullable(),
  artist: z.string().nullable(),
  albumArtist: z.string().nullable(),
  compilation: z.boolean(),
  year: z.number().nullable(),
  genres: z.array(z.string()),
  formats: z.array(z.string()),
  discCount: z.number(),
  trackCount: z.number(),
  durationSec: z.number(),
  sizeBytes: z.number(),
  source: z.string(),
  encodingFixedTracks: z.number(),
  untaggedTracks: z.number(),
  tracks: z.array(TrackSchema),
});

const ArtistSchema = z.object({
  kind: z.literal("artist"),
  key: z.string(),
  name: z.string(),
  variants: z.array(z.string()),
  albumCount: z.number(),
  trackCount: z.number(),
  durationSec: z.number(),
  genres: z.array(z.string()),
  formats: z.array(z.string()),
  yearFrom: z.number().nullable(),
  yearTo: z.number().nullable(),
  albums: z.array(
    z.object({
      key: z.string(),
      title: z.string().nullable(),
      year: z.number().nullable(),
      trackCount: z.number(),
    }),
  ),
});

const DimensionSchema = z.object({
  kind: z.literal("dimension"),
  dimension: z.string(),
  entries: z.unknown(),
  scannedAt: z.string(),
});

const IssuesSchema = z.object({
  kind: z.literal("issues"),
  untagged: z.array(
    z.object({ path: z.string(), missing: z.array(z.string()) }),
  ),
  dirnameOnlyAlbums: z.array(
    z.object({ key: z.string(), dir: z.string() }),
  ),
  encodingFixes: z.array(
    z.object({
      path: z.string(),
      field: z.string(),
      before: z.string(),
      after: z.string(),
      encoding: z.string().nullable(),
    }),
  ),
  dosMangledNames: z.array(z.string()),
  scannedAt: z.string(),
});

const LibrarySchema = z.object({
  kind: z.literal("library"),
  scannedAt: z.string(),
  params: z.object({
    pathPrefix: z.string(),
    maxAlbums: z.number(),
    dryRun: z.boolean(),
  }),
  db: z.object({ host: z.string(), path: z.string() }),
  totals: z.object({
    tracks: z.number(),
    albums: z.number(),
    artists: z.number(),
    genres: z.number(),
    durationSec: z.number(),
    sizeBytes: z.number(),
  }),
  sources: z.object({
    tags: z.number(),
    mixed: z.number(),
    dirname: z.number(),
    none: z.number(),
  }),
  encodingFixedTracks: z.number(),
  untaggedTracks: z.number(),
  dosMangledNames: z.number(),
  formats: z.record(z.string(), z.number()),
});

const DupesSchema = z.object({
  kind: z.literal("dupes"),
  scannedAt: z.string(),
  params: z.object({ pathPrefix: z.string(), maxTrackClusters: z.number() }),
  stats: z.object({
    albumClusters: z.number(),
    albumsInvolved: z.number(),
    reclaimableBytes: z.number(),
    trackClusters: z.number(),
    trackClustersAcrossAlbums: z.number(),
    trackFilesInvolved: z.number(),
    trackClustersTruncated: z.boolean(),
  }),
  albumClusters: z.unknown(),
  trackClusters: z.unknown(),
});

const VerifySchema = z.object({
  kind: z.literal("verify"),
  mode: z.string(),
  startedAt: z.string(),
  elapsedSec: z.number(),
  params: z.object({
    path: z.string(),
    pathPrefix: z.string(),
    limit: z.number(),
    concurrency: z.number(),
    quickTailSec: z.number(),
  }),
  checked: z.number(),
  ok: z.number(),
  failed: z.number(),
  errors: z.number(),
  truncated: z.number(),
  missingRecords: z.number(),
  skippedUnsafePaths: z.number(),
  problemsTruncated: z.boolean(),
  problems: z.array(
    z.object({
      path: z.string(),
      status: z.string(),
      rc: z.number(),
      expectedSec: z.number().nullable(),
      decodedSec: z.number().nullable(),
      errors: z.array(z.string()),
    }),
  ),
});

const BpmSchema = z.object({
  kind: z.literal("bpm"),
  startedAt: z.string(),
  elapsedSec: z.number(),
  params: z.object({
    path: z.string(),
    pathPrefix: z.string(),
    limit: z.number(),
    concurrency: z.number(),
    windowSec: z.number(),
    windowStart: z.number(),
    minLengthSec: z.number(),
    maxLengthSec: z.number(),
    perFileTimeoutSec: z.number(),
    reanalyze: z.boolean(),
    maxTracks: z.number(),
  }),
  analyzed: z.number(),
  carriedOver: z.number(),
  failed: z.number(),
  newlyFailed: z.number(),
  skippedShort: z.number(),
  skippedLong: z.number(),
  skippedUnsafePaths: z.number(),
  missingRecords: z.number(),
  stats: z.object({
    bpmMedian: z.number().nullable(),
    confidenceBands: z.record(z.string(), z.number()),
    bpmHistogram: z.record(z.string(), z.number()),
    analysisRateX: z.number().nullable(),
  }),
  tracksTruncated: z.boolean(),
  failuresTruncated: z.boolean(),
  tracks: z.array(
    z.object({
      path: z.string(),
      bpm: z.number().nullable(),
      beatsConfidence: z.number().nullable(),
      confidenceBand: z.string(),
      beatsCount: z.number().nullable(),
      ibiCv: z.number().nullable(),
      estStd: z.number().nullable(),
      key: z.string().nullable(),
      scale: z.string().nullable(),
      keyStrength: z.number().nullable(),
      danceability: z.number().nullable(),
      lengthSec: z.number().nullable(),
      analyzedSec: z.number().nullable(),
      windowed: z.boolean(),
      ms: z.number().nullable(),
    }),
  ),
  failures: z.array(z.object({ path: z.string(), err: z.string() })),
});

const PlaylistSchema = z.object({
  kind: z.literal("playlist"),
  generatedAt: z.string(),
  source: z.string(),
  sourceAnalyzed: z.number(),
  params: z.object({
    pathPrefix: z.string(),
    minSpm: z.number(),
    maxSpm: z.number(),
    minConfidence: z.number(),
    targetMin: z.number(),
    limit: z.number(),
  }),
  tracksTotal: z.number(),
  eligible: z.number(),
  excluded: z.object({ noPulse: z.number(), outOfRange: z.number() }),
  totalSec: z.number(),
  buckets: z.array(
    z.object({
      range: z.string(),
      tracks: z.number(),
      minutes: z.number(),
    }),
  ),
  albums: z.array(
    z.object({
      dir: z.string(),
      tracks: z.number(),
      runnable: z.number(),
      meanConfidence: z.number(),
    }),
  ),
  tracks: z.array(
    z.object({
      path: z.string(),
      bpm: z.number(),
      spm: z.number(),
      mult: z.number(),
      confidence: z.number(),
      danceability: z.number().nullable(),
      key: z.string().nullable(),
      scale: z.string().nullable(),
      lengthSec: z.number(),
    }),
  ),
});

const ProbeSchema = z.object({
  kind: z.literal("probe"),
  path: z.string(),
  containerPath: z.string(),
  format: z.unknown(),
  audioStream: z.unknown(),
  tags: z.record(z.string(), z.string()),
  encodingTrace: z.array(
    z.object({
      field: z.string(),
      before: z.string(),
      after: z.string(),
      encoding: z.string().nullable(),
    }),
  ),
  probedAt: z.string(),
});

const ArtistMapEntrySchema = z.object({
  artistKey: z.string(),
  artistName: z.string(),
  mbid: z.string().nullable(),
  status: z.enum(["resolved", "ambiguous", "unresolved"]),
  source: z.enum(["seed", "search"]).nullable(),
  candidates: z.array(z.object({ id: z.string(), name: z.string() })),
  // OPTIONAL — the timestamp of the last MusicBrainz SEARCH that produced a
  // verdict for this artist (never a seed match — see needsSearch and
  // resolve-artists' merge rules below). Optional because the live
  // 2258-entry map predates this field; resolve-artists reads that exact
  // document back, so a required field would fail validation on the very
  // first post-merge run and silently degrade to an empty prior, wiping
  // every resolved mbid.
  checkedAt: z.string().optional(),
});

const ArtistMapSchema = z.object({
  kind: z.literal("artistMap"),
  scannedAt: z.string(),
  params: z.object({
    headphonesInstance: z.string(),
    musicbrainzInstance: z.string(),
  }),
  resolved: z.number(),
  ambiguous: z.number(),
  unresolved: z.number(),
  entries: z.array(ArtistMapEntrySchema),
  // THREE optional top-level completeness fields — what makes a TRUNCATED
  // run (search-artists-batch stopped on max-queries/max-duration/aborted/
  // backoff) distinguishable from a CONVERGED one. Without them,
  // `unresolved: 1083` is ambiguous between "MusicBrainz does not know
  // them" and "we never asked". All three are ALWAYS set on WRITE by
  // resolve-artists; optional here for the same live-document reason as
  // `checkedAt` above.
  pendingSearch: z.number().optional(),
  truncated: z.boolean().optional(),
  stopReason: z.string().nullable().optional(),
});

/**
 * Freshness policy for resolve-artists' 30-day reuse cache — the
 * Inventory-side mirror of musicbrainz.ts's `isCacheStale`, placed beside
 * the cache (`ArtistMapEntrySchema`'s `checkedAt`) it governs. Pure — `now`
 * is always a parameter, never read from the clock internally.
 *
 * Returns true (needs a fresh MusicBrainz search) when: `prior` is
 * null/undefined (nothing to reuse); `checkedAt` is absent or unparsable;
 * `now - parsed >= ttlMs` (stale); or — defensively — `parsed > now` (a
 * FUTURE timestamp, from clock skew, must not park an artist forever by
 * looking artificially fresh).
 */
export function needsSearch(
  prior: { checkedAt?: string | null } | null | undefined,
  now: number,
  ttlMs: number,
): boolean {
  if (!prior) return true;
  const checkedAt = prior.checkedAt;
  if (!checkedAt) return true;
  const parsed = Date.parse(checkedAt);
  if (!Number.isFinite(parsed)) return true;
  if (parsed > now) return true;
  return now - parsed >= ttlMs;
}

const WantEntrySchema = z.object({
  artist: z.string(),
  artistName: z.string(),
  releaseGroupId: z.string(),
  title: z.string(),
  kind: z.enum(["missing", "upgrade"]),
  quality: z.string().nullable(),
  targetQuality: z.string(),
  primaryType: z.string().nullable(),
  secondaryTypes: z.array(z.string()),
  firstReleaseDate: z.string().nullable(),
});

const WantedSchema = z.object({
  kind: z.literal("wanted"),
  generatedAt: z.string(),
  params: z.object({
    artistMapName: z.string(),
    musicbrainzInstance: z.string(),
    targetQuality: z.string(),
    uncertainMatchPresent: z.boolean(),
  }),
  total: z.number(),
  missing: z.number(),
  upgrade: z.number(),
  wants: z.array(WantEntrySchema),
});

// --- SQL ---

const TRACKS_SQL = `
SELECT t.id, t.filename, t.tag_title, t.tag_track_artist,
       t.tag_track_number AS track_number, t.tag_disc_number AS disc_number,
       t.tag_year, t.length, t.bitrate, t.size,
       a.left_path, a.right_path, a.tag_title AS album_title,
       a.tag_album_artist AS album_artist, a.tag_year AS album_year,
       a.tag_compilation AS compilation
FROM tracks t JOIN albums a ON t.album_id = a.id
ORDER BY a.left_path, a.right_path, t.tag_disc_number, t.tag_track_number,
         t.filename;`;

const GENRES_SQL = `
SELECT tg.track_id, g.name
FROM track_genres tg JOIN genres g ON g.id = tg.genre_id;`;

const VERIFY_SQL = `
SELECT t.filename, t.length, a.left_path, a.right_path
FROM tracks t JOIN albums a ON t.album_id = a.id
ORDER BY a.left_path, a.right_path, t.filename;`;

// --- Artist resolution (resolve-artists) + want derivation (wanted) helpers
// --- Both methods are the first to read ANOTHER swamp model instance's data
// (context.readModelData) — see the two functions below for the shared,
// defensive row-reading shape every downstream test in the RED-phase suites
// exercises (missing capability, missing spec, and malformed rows must all
// degrade to "nothing contributed", never an unhandled throw).

/**
 * Read rows from a model instance's data spec via context.readModelData,
 * defaulting to [] when the capability itself, or the spec, is unavailable
 * — this is the "no data yet" case (nobody scanned/synced this spec), which
 * callers distinguish from a genuinely missing PREREQUISITE by checking the
 * returned array's length themselves (see resolve-artists/wanted below).
 */
async function readRows(
  context: {
    readModelData?: (
      instanceName: string,
      specName: string,
    ) => Promise<unknown[]>;
  },
  instanceName: string,
  specName: string,
): Promise<Record<string, unknown>[]> {
  if (!context.readModelData) return [];
  const rows = await context.readModelData(instanceName, specName);
  return Array.isArray(rows) ? (rows as Record<string, unknown>[]) : [];
}

/** A readModelData row's parsed content lives at row.attributes.<field>. */
function rowAttrs(row: unknown): Record<string, unknown> {
  const attrs = (row as { attributes?: unknown } | null | undefined)
    ?.attributes;
  return attrs && typeof attrs === "object"
    ? (attrs as Record<string, unknown>)
    : {};
}

/** Parsed prior artistMap entry, indexed by artistKey — only the fields
 * resolve-artists' merge semantics (step 10) need. */
type PriorArtistMapEntry = {
  mbid: string | null;
  status: "resolved" | "ambiguous" | "unresolved";
  source: "seed" | "search" | null;
  candidates: { id: string; name: string }[];
  checkedAt?: string;
};

/**
 * Reads the prior `artistMap` resource (if any) and indexes it by
 * artistKey — the LOAD half of resolve-artists' load-modify-write aggregate
 * lifecycle (step 10 of musicbrainz-ratelimit-runmodel-fanout). Without
 * this, "a converged re-run costs zero requests" never happens, and the
 * obvious improvisation (skip the search and fall through the existing
 * code path) writes every reused entry back as `unresolved`/`mbid: null`,
 * silently wiping every previously resolved/ambiguous artist.
 * `readResource` is a NEW capability requirement for this method (only
 * `wanted` uses it today), so it is optional-chained rather than throwing —
 * `readResource` absent, the resource missing, or `entries` not an array
 * all degrade to an EMPTY prior map, which reproduces today's
 * (pre-persistence) behaviour exactly and is therefore never destructive.
 */
async function readPriorArtistMap(
  context: {
    readResource?: (name: string) => Promise<unknown>;
  },
  name: string,
): Promise<Map<string, PriorArtistMapEntry>> {
  const prior = new Map<string, PriorArtistMapEntry>();
  if (!context.readResource) return prior;
  const raw = await context.readResource(name);
  const entries = (raw as { entries?: unknown } | null | undefined)?.entries;
  if (!Array.isArray(entries)) return prior;
  for (const e of entries) {
    if (!e || typeof e !== "object") continue;
    const entry = e as Record<string, unknown>;
    const artistKey = typeof entry.artistKey === "string"
      ? entry.artistKey
      : null;
    if (!artistKey) continue;
    const rawCandidates = Array.isArray(entry.candidates)
      ? entry.candidates
      : [];
    const candidates = rawCandidates
      .filter((c): c is Record<string, unknown> => !!c && typeof c === "object")
      .map((c) => ({
        id: typeof c.id === "string" ? c.id : "",
        name: typeof c.name === "string" ? c.name : "",
      }));
    prior.set(artistKey, {
      mbid: typeof entry.mbid === "string" ? entry.mbid : null,
      status: entry.status === "resolved" || entry.status === "ambiguous" ||
          entry.status === "unresolved"
        ? entry.status
        : "unresolved",
      source: entry.source === "seed" || entry.source === "search"
        ? entry.source
        : null,
      candidates,
      checkedAt: typeof entry.checkedAt === "string"
        ? entry.checkedAt
        : undefined,
    });
  }
  return prior;
}

/**
 * Selects the `search-artists-batch` result row matching `batchId` out of
 * every row `readModelData` returns for the instance's `artistSearchBatch`
 * spec — deterministic by CORRELATION IDENTITY, not recency or array order.
 * `isLatest` occurred nowhere in this contract and no test ever set it, so
 * every prior caller silently depended on a `rows[length-1]` fallback;
 * `batchId` removes that dependence entirely. Throws (never returns null)
 * so a missing row surfaces immediately, naming the instance and batchId,
 * rather than parking every searched artist as if nothing had been asked.
 */
function selectBatchRow(
  rows: Record<string, unknown>[],
  batchId: string,
  musicbrainzInstance: string,
): Record<string, unknown> {
  for (const row of rows) {
    const attrs = rowAttrs(row);
    if (attrs.batchId === batchId) return attrs;
  }
  throw new Error(
    `No artistSearchBatch row with batchId "${batchId}" found on instance "${musicbrainzInstance}" after running search-artists-batch — it may have failed to write its resource.`,
  );
}

type ArtistMapEntry = {
  artistKey: string;
  artistName: string;
  mbid: string | null;
  status: "resolved" | "ambiguous" | "unresolved";
  source: "seed" | "search" | null;
  candidates: { id: string; name: string }[];
  // THE FIFTH MIRROR of ArtistMapEntrySchema's checkedAt (see step 9 of
  // musicbrainz-ratelimit-runmodel-fanout) — optional for the same reason
  // the schema field is. This is the type resolve-artists actually
  // constructs against (`entries.push({...})` below); omitting this field
  // here while writing checkedAt into that object literal is a TS2353
  // excess-property error, and music-library's `check` task enumerates this
  // file, so it is a hard build break, not a style point.
  checkedAt?: string;
};

/**
 * Best (highest-ranked) quality bucket across an album's tracks — reuses
 * qualityBucket()/QUALITY_RANK so the OwnedAlbum `wanted` builds compares
 * apples to apples against `targetQuality`.
 */
function albumQualityBucket(tracksAttr: unknown): QualityBucket {
  const tracks = Array.isArray(tracksAttr) ? tracksAttr : [];
  let best: QualityBucket = "unknown";
  let bestRank = QUALITY_RANK.indexOf(best);
  for (const t of tracks as Record<string, unknown>[]) {
    const format = typeof t?.format === "string" ? t.format : "";
    const bitrate = typeof t?.bitrateKbps === "number" ? t.bitrateKbps : null;
    const bucket = qualityBucket(format, bitrate) as QualityBucket;
    const rank = QUALITY_RANK.indexOf(bucket);
    if (rank > bestRank) {
      best = bucket;
      bestRank = rank;
    }
  }
  return best;
}

// --- Model ---

/**
 * Multidimensional music library catalog: album facts, artist/genre/year/
 * format/quality dimensions, and data-quality worklists, built from the gonic
 * scan index (no filesystem traversal) with tag-encoding recovery and
 * directory-naming fallback.
 */
export const model = {
  type: "@magistr/music-library",
  version: "2026.08.07.1",
  upgrades: [
    {
      fromVersion: "2026.07.17.1",
      toVersion: "2026.08.02.1",
      description:
        "Fix all 6 music-library-latent-bugs (verify per-file ffmpeg timeout + transport ceiling, path-traversal confinement, empty-ffprobe/JSON typed errors, RS-safe record framing, correct even-count median, bounded bpm tracks/failures) -- adds defaulted ffmpegDecodeTimeoutSec global arg + bpm maxTracks method arg; additive bpm schema fields only",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      fromVersion: "2026.08.02.1",
      toVersion: "2026.08.04.1",
      description:
        "Add the wanted derivation: resolve-artists (artist name -> MBID map, seeded from a headphones instance, token-set MusicBrainz search fallback, ambiguous/unresolved parked for human review) and wanted (pure derivation of missing albums + quality upgrades over the cached map, MusicBrainz browse cache, and the album cube). Adds artistMap + wanted resources and the @magistr/music-wanted report; extracts normDupeKey/isNoiseGroup to extensions/lib/norm.ts to break a models<->lib import cycle (re-exported, so existing importers are unchanged); fixes running's bpm-pointer error which interpolated the non-existent context.modelName and rendered 'undefined'. Purely additive -- no stored resource is reshaped",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      fromVersion: "2026.08.04.1",
      toVersion: "2026.08.05.1",
      description:
        "Fixes musicbrainz-ratelimit-runmodel-fanout, measured live: resolve-artists fanned out ONE context.runModel call per seed-unresolved artist (~1483 calls in one run), and MusicBrainz's rate limiter has no memory across separate runModel invocations, so real traffic ran at ~2.5 req/sec against the documented 1 req/sec limit. resolve-artists now issues AT MOST ONE runModel call per run, to the new @magistr/musicbrainz search-artists-batch method, and persists its own output as a reusable cache: a prior run's artistMap is loaded (context.readResource, a new capability requirement for this method, optional-chained so a missing/absent prior degrades to empty rather than throwing) and a seed-unresolved artist whose verdict is younger than ttlMs (new arg, default 30 days) is reused without a fresh search, so a converged re-run costs zero MusicBrainz requests. Deletes searchMusicBrainzArtists and its isLatest selector outright -- no dual path. New optional entry field checkedAt (the timestamp of the last MusicBrainz SEARCH that produced a verdict; NEVER set on a seed match) and three new optional top-level fields pendingSearch/truncated/stopReason on ArtistMapSchema, distinguishing a converged run from one cut short by search-artists-batch's own maxQueries/maxDurationMs/an aborted signal/a Retry-After backoff -- all four optional since the live map predates them. resolve-artists gains refresh (force-recheck everything), refreshKeys (force-recheck specific artists, ordered first in the batch so they can never be crowded out by maxQueries), maxQueries, and maxDurationMs method arguments. New exported pure needsSearch(prior, now, ttlMs) freshness predicate beside ArtistMapEntrySchema, mirroring musicbrainz.ts's isCacheStale. wanted.ts's ArtistMapEntry/ArtistMapContent report-side mirrors gain the same four fields. All additive to ArtistMapSchema -- no existing field changes shape, so the live 2258-entry map validates and loads unchanged on the first post-merge run.",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      fromVersion: "2026.08.05.1",
      toVersion: "2026.08.05.2",
      description:
        "Fixes music-wanted-sequence-not-wired: wanted's missing-browse-cache throw named a nonexistent 'browse' method (browse-release-groups/browse-releases/browse-recordings exist; 'browse' is a resource spec name, not a method), so an operator who skipped the discography sync got unknown_method instead of an actionable fix. The throw now names the real runnable command — swamp model method run <mbInstance> sync-artist-discographies --input 'artistMbids:json=[...]' — plus the swamp data query extraction command (with its envelope shape) to build that artist list from this instance's own artistMap, and the repo-local music-wanted workflow line. No schema or resource shape change.",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      fromVersion: "2026.08.05.2",
      toVersion: "2026.08.07.1",
      description:
        "Fixes music-wanted-workflow-packaging: ships the music-wanted workflow body as extensions/workflows/music-wanted.yaml (registered under the new manifest workflows: key as @magistr/music-wanted-sequence), so a 464-line artefact that previously existed in exactly one copy, in a tree with neither .git nor .jj, gets version control, review and diffability. wanted's missing-browse-cache throw no longer says 'Repo-local: the homelab repo wires the whole sequence as a workflow' — it names the shipped file and the create-and-paste procedure, while keeping the substring 'swamp workflow run music-wanted' for the author's own homelab copy. No schema or resource shape change.",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
  ],
  reports: [
    "@magistr/music-verify-triage",
    "@magistr/music-bpm-running",
    "@magistr/music-wanted",
  ],
  globalArguments: GlobalArgsSchema,
  resources: {
    library: {
      description: "Library summary with dimension cardinalities",
      schema: LibrarySchema,
      lifetime: "infinite",
      garbageCollection: 5,
    },
    album: {
      description: "Album fact: one directory with its discs and tracks",
      schema: AlbumSchema,
      lifetime: "infinite",
      garbageCollection: 3,
    },
    artist: {
      description: "Artist dimension: albums, genres, formats, year span",
      schema: ArtistSchema,
      lifetime: "infinite",
      garbageCollection: 3,
    },
    dimension: {
      description: "Rollup dimension (genres / years / formats / quality)",
      schema: DimensionSchema,
      lifetime: "infinite",
      garbageCollection: 5,
    },
    issues: {
      description:
        "Data-quality worklists: untagged, dirname-only, encoding fixes",
      schema: IssuesSchema,
      lifetime: "infinite",
      garbageCollection: 5,
    },
    dupes: {
      description: "Duplicate album and track clusters with keep/reclaim hints",
      schema: DupesSchema,
      lifetime: "infinite",
      garbageCollection: 5,
    },
    verify: {
      description:
        "Playback-integrity report: decode results, corrupt/truncated files",
      schema: VerifySchema,
      lifetime: "infinite",
      garbageCollection: 5,
    },
    bpm: {
      description:
        "Tempo analysis: bpm, beat-detection confidence, key and danceability per track",
      schema: BpmSchema,
      lifetime: "infinite",
      garbageCollection: 5,
    },
    playlist: {
      description:
        "Cadence-matched running playlist derived from a bpm resource",
      schema: PlaylistSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    probe: {
      description: "Deep ffprobe result for a single file",
      schema: ProbeSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    artistMap: {
      description:
        "Cached artist-name to MusicBrainz-ID map: seeded from headphones, backfilled by a token-set MusicBrainz search, ambiguous/unresolved artists parked for human review",
      schema: ArtistMapSchema,
      lifetime: "infinite",
      garbageCollection: 5,
    },
    wanted: {
      description:
        "Want-set derived by diffing the cached MusicBrainz discography against the owned library cube, recomputed from scratch on every run",
      schema: WantedSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  methods: {
    scan: {
      description:
        "Build the multidimensional catalog from the gonic index: album facts, artist/genre/year/format/quality dimensions, issue worklists",
      arguments: z.object({
        pathPrefix: z
          .string()
          .default("")
          .describe(
            "Only include tracks whose library-relative path starts with this prefix",
          ),
        maxAlbums: z
          .number()
          .int()
          .min(0)
          .default(0)
          .describe("Cap the number of albums (0 = no cap) — for test runs"),
        dryRun: z
          .boolean()
          .default(false)
          .describe(
            "Compute everything but write only the library summary resource",
          ),
      }),
      execute: async (args, context) => {
        const { host, sshUser, dbPath } = context.globalArgs;
        const scannedAt = new Date().toISOString();

        const rows = await sqliteJson(host, sshUser, dbPath, TRACKS_SQL);
        const genreRows = await sqliteJson(host, sshUser, dbPath, GENRES_SQL);
        const genresByTrack = new Map();
        for (const gr of genreRows) {
          if (!genresByTrack.has(gr.track_id)) {
            genresByTrack.set(gr.track_id, []);
          }
          genresByTrack.get(gr.track_id)!.push(gr.name);
        }

        const cube = buildCube(rows, genresByTrack, {
          pathPrefix: args.pathPrefix,
          maxAlbums: args.maxAlbums,
          legacyEncodings: context.globalArgs.legacyEncodings,
        });

        const handles: unknown[] = [];
        if (!args.dryRun) {
          for (const alb of cube.albums) {
            handles.push(await context.writeResource("album", alb.key, alb));
          }
          for (const art of cube.artists) {
            handles.push(
              await context.writeResource("artist", art.key, art),
            );
          }
          for (
            const [dimName, entries] of Object.entries(cube.dims)
          ) {
            handles.push(
              await context.writeResource("dimension", `dim-${dimName}`, {
                kind: "dimension",
                dimension: dimName,
                entries,
                scannedAt,
              }),
            );
          }
          handles.push(
            await context.writeResource("issues", "issues", {
              kind: "issues",
              ...cube.issues,
              scannedAt,
            }),
          );
        }
        const summaryHandle = await context.writeResource(
          "library",
          "summary",
          {
            ...cube.summary,
            scannedAt,
            params: {
              pathPrefix: args.pathPrefix,
              maxAlbums: args.maxAlbums,
              dryRun: args.dryRun,
            },
            db: { host, path: dbPath },
          },
        );
        handles.push(summaryHandle);
        return { dataHandles: handles };
      },
    },

    dupes: {
      description:
        "Find duplicate albums (same artist+title in different dirs, with a keep-best hint and reclaimable bytes) and duplicate tracks (same artist+title, near-equal duration)",
      arguments: z.object({
        pathPrefix: z
          .string()
          .default("")
          .describe(
            "Only consider tracks whose library-relative path starts with this prefix",
          ),
        maxTrackClusters: z
          .number()
          .int()
          .min(0)
          .default(1000)
          .describe(
            "Cap track clusters stored in the resource (0 = no cap); album clusters are never capped",
          ),
      }),
      execute: async (args, context) => {
        const { host, sshUser, dbPath } = context.globalArgs;
        const scannedAt = new Date().toISOString();

        const rows = await sqliteJson(host, sshUser, dbPath, TRACKS_SQL);
        const cube = buildCube(rows, new Map(), {
          pathPrefix: args.pathPrefix,
          legacyEncodings: context.globalArgs.legacyEncodings,
        });
        const { albumClusters, trackClusters } = findDupes(cube.albums);

        const cap = args.maxTrackClusters;
        const truncated = cap > 0 && trackClusters.length > cap;
        const kept = truncated ? trackClusters.slice(0, cap) : trackClusters;

        const handle = await context.writeResource("dupes", "dupes", {
          kind: "dupes",
          scannedAt,
          params: {
            pathPrefix: args.pathPrefix,
            maxTrackClusters: args.maxTrackClusters,
          },
          stats: {
            albumClusters: albumClusters.length,
            albumsInvolved: albumClusters.reduce(
              (a, c) => a + c.albums.length,
              0,
            ),
            reclaimableBytes: albumClusters.reduce(
              (a, c) => a + c.reclaimableBytes,
              0,
            ),
            trackClusters: trackClusters.length,
            trackClustersAcrossAlbums: trackClusters.filter((c) =>
              c.acrossAlbums
            ).length,
            trackFilesInvolved: trackClusters.reduce(
              (a, c) => a + c.count,
              0,
            ),
            trackClustersTruncated: truncated,
          },
          albumClusters,
          trackClusters: kept,
        });
        return { dataHandles: [handle] };
      },
    },

    verify: {
      description:
        "Check playback integrity by decoding files with ffmpeg inside the container: full decode, or quick tail decode (seeks near the end using the indexed duration) — reports unreadable, corrupt, and truncated files",
      arguments: z.object({
        path: z
          .string()
          .default("")
          .describe(
            "Verify a single file (library-relative or absolute path); forces full mode",
          ),
        pathPrefix: z
          .string()
          .default("")
          .describe(
            "Only verify files whose library-relative path starts with this prefix",
          ),
        limit: z
          .number()
          .int()
          .min(0)
          .default(0)
          .describe("Cap the number of files (0 = no cap)"),
        concurrency: z
          .number()
          .int()
          .min(1)
          .max(8)
          .default(4)
          .describe("Parallel SSH decode workers"),
        mode: z
          .enum(["full", "quick"])
          .default("full")
          .describe(
            "full = decode every sample; quick = decode only the file tail (fast, catches truncation and unreadable files)",
          ),
        quickTailSec: z
          .number()
          .int()
          .min(3)
          .max(120)
          .default(15)
          .describe("Tail seconds decoded in quick mode"),
      }),
      execute: async (args, context) => {
        const {
          host,
          sshUser,
          dbPath,
          container,
          containerMusicRoot,
          hostMusicRoot,
          ffmpegDecodeTimeoutSec,
        } = context.globalArgs;
        const startedAt = new Date();

        // work list: container path + expected duration from the index
        let files: {
          cpath: string;
          rel: string;
          expectedSec: number | null;
        }[] = [];
        if (args.path) {
          const p = confineContainerPath(
            hostMusicRoot,
            containerMusicRoot,
            args.path,
          );
          files.push({
            cpath: p,
            rel: p.slice(containerMusicRoot.length + 1),
            expectedSec: null,
          });
        } else {
          const rows = await sqliteJson(host, sshUser, dbPath, VERIFY_SQL);
          for (const row of rows) {
            const rel = (row.left_path || "") + row.right_path + "/" +
              row.filename;
            if (args.pathPrefix && !rel.startsWith(args.pathPrefix)) continue;
            files.push({
              cpath: containerMusicRoot + "/" + rel,
              rel,
              expectedSec: row.length || null,
            });
          }
          if (args.limit > 0) files = files.slice(0, args.limit);
        }
        // control chars would break the record framing; newline-in-filename
        // cannot survive the read loop either
        const safe = files.filter((f) =>
          !["\n", "\r", "\x1e", "\x1f"].some((c) => f.cpath.includes(c))
        );
        const skippedUnsafePaths = files.length - safe.length;
        const mode = args.path ? "full" : args.mode;

        // one serial decode loop per SSH worker; stdin carries the file
        // list, so ffmpeg needs -nostdin. Records: path US rc US output RS.
        // Per-file guard (LB1): wrap the ffmpeg invocation with the shell
        // `timeout` command when ffmpegDecodeTimeoutSec > 0 — detected once
        // per worker (`command -v timeout`), degrading gracefully if the
        // container lacks it. On expiry `timeout` returns 124, the loop
        // records that file's result and CONTINUES to the next one instead
        // of hanging the rest of the chunk forever.
        const timeoutPrefix = ffmpegDecodeTimeoutSec > 0
          ? `if command -v timeout >/dev/null 2>&1; then TO="timeout ${ffmpegDecodeTimeoutSec}"; else TO=""; fi; `
          : "";
        const ffmpegInvocation = ffmpegDecodeTimeoutSec > 0
          ? "$TO ffmpeg"
          : "ffmpeg";
        const fullScript =
          `${timeoutPrefix}while IFS= read -r f; do out=$(${ffmpegInvocation} -nostdin -v error -stats -i "$f" -map 0:a -f null - 2>&1); rc=$?; printf "%s\\037%s\\037%s\\036" "$f" "$rc" "$out"; done`;
        // default IFS here: the first word is the seek offset, the rest of
        // the line (spaces included) lands in $f
        const quickScript =
          `${timeoutPrefix}while read -r off f; do out=$(${ffmpegInvocation} -nostdin -v error -stats -ss "$off" -i "$f" -map 0:a -f null - 2>&1); rc=$?; printf "%s\\037%s\\037%s\\036" "$f" "$rc" "$out"; done`;
        const script = mode === "quick" ? quickScript : fullScript;
        const remoteCmd = `docker exec -i ${shQuote(container)} sh -c ${
          shQuote(script)
        }`;

        const workerCount = Math.min(
          args.concurrency,
          Math.max(1, safe.length),
        );
        const chunks: typeof safe[] = Array.from(
          { length: workerCount },
          () => [],
        );
        safe.forEach((f, i) => chunks[i % workerCount].push(f));

        const outputs = await Promise.all(chunks.map((chunk) => {
          if (chunk.length === 0) return Promise.resolve("");
          const stdin = chunk.map((f) =>
            mode === "quick"
              ? `${
                Math.max(0, (f.expectedSec || 0) - args.quickTailSec)
              } ${f.cpath}`
              : f.cpath
          ).join("\n") + "\n";
          // Transport ceiling (LB1): generously sized per worker so it only
          // fires if the remote `timeout` itself failed or ssh/network
          // wedged — the remote per-file `timeout` above is the real guard.
          const transportTimeoutMs = ffmpegDecodeTimeoutSec > 0
            ? (ffmpegDecodeTimeoutSec * chunk.length + 60) * 1000
            : undefined;
          return sshRun(host, sshUser, remoteCmd, stdin, transportTimeoutMs);
        }));

        const byPath = new Map(safe.map((f) => [f.cpath, f]));
        const seen = new Set<string>();
        let okCount = 0;
        let failedCount = 0;
        let errorsCount = 0;
        let truncatedCount = 0;
        const problems: VerifyProblem[] = [];
        for (const out of outputs) {
          // RS-safe reassembly (LB4): the `safe` filter above only screens
          // INPUT filenames for control bytes — it never touches ffmpeg's
          // OWN captured stderr/stdout text, which can itself contain a
          // stray RS (0x1e) byte and split one real record in two. A
          // fragment's leading US-delimited field is a real record only when
          // it matches a KNOWN cpath; otherwise it is the tail of the
          // PREVIOUS record's ffmpeg output, so restore the RS and fold it
          // back rather than treating it as an unmatchable orphan record.
          const frags: string[] = [];
          for (const frag of out.split("\x1e")) {
            if (!frag.trim()) continue;
            const head = frag.split("\x1f", 1)[0];
            if (frags.length > 0 && !byPath.has(head)) {
              frags[frags.length - 1] += "\x1e" + frag;
            } else {
              frags.push(frag);
            }
          }
          for (const rec of frags) {
            const parts = rec.split("\x1f");
            const f = byPath.get(parts[0]);
            if (!f) continue;
            seen.add(parts[0]);
            const rcn = Number.parseInt(parts[1] ?? "", 10);
            const rc = Number.isFinite(rcn) ? rcn : 1;
            const body = parts.slice(2).join("\x1f");
            const { decodedSec, errorLines } = parseFfmpegVerifyOutput(body);
            const status = classifyVerify(
              rc,
              errorLines,
              f.expectedSec,
              decodedSec,
              mode,
              args.quickTailSec,
            );
            if (status === "ok") okCount += 1;
            else {
              if (status === "failed") failedCount += 1;
              else if (status === "errors") errorsCount += 1;
              else truncatedCount += 1;
              problems.push({
                path: f.rel,
                status,
                rc,
                expectedSec: f.expectedSec,
                decodedSec,
                errors: errorLines.slice(0, 8).map((l) => l.slice(0, 200)),
              });
            }
          }
        }
        const missingRecords = safe.length - seen.size;
        const problemsTruncated = problems.length > 2000;
        const reportName = args.path
          ? `verify-file-${slugify(args.path.split("/").pop() || args.path)}-${
            hash8(args.path)
          }`
          : args.pathPrefix
          ? `verify-${slugify(args.pathPrefix)}-${hash8(args.pathPrefix)}`
          : "verify-library";

        const handle = await context.writeResource("verify", reportName, {
          kind: "verify",
          mode,
          startedAt: startedAt.toISOString(),
          elapsedSec: Math.round((Date.now() - startedAt.getTime()) / 1000),
          params: {
            path: args.path,
            pathPrefix: args.pathPrefix,
            limit: args.limit,
            concurrency: args.concurrency,
            quickTailSec: args.quickTailSec,
          },
          checked: seen.size,
          ok: okCount,
          failed: failedCount,
          errors: errorsCount,
          truncated: truncatedCount,
          missingRecords,
          skippedUnsafePaths,
          problemsTruncated,
          problems: problemsTruncated ? problems.slice(0, 2000) : problems,
        });
        return { dataHandles: [handle] };
      },
    },

    bpm: {
      description:
        "Analyze tempo per track (essentia): bpm, beat-detection confidence, key/scale and danceability — the confidence tells a real pulse from a grid imposed on rubato",
      arguments: z.object({
        path: z
          .string()
          .default("")
          .describe(
            "Analyze a single file: library-relative, or absolute host/container path",
          ),
        pathPrefix: z
          .string()
          .default("")
          .describe(
            "Only analyze tracks whose library-relative path starts with this prefix",
          ),
        limit: z
          .number()
          .int()
          .min(0)
          .default(0)
          .describe("Cap the number of tracks analyzed (0 = no cap)"),
        concurrency: z
          .number()
          .int()
          .min(1)
          .max(32)
          .default(8)
          .describe(
            "Parallel analyzer containers; each one decodes and analyzes its chunk serially",
          ),
        windowSec: z
          .number()
          .min(0)
          .default(0)
          .describe(
            "Analyze only this many seconds of each track (0 = whole track). A 120s window reproduces whole-track bpm to within ~1 bpm. It caps analysis cost, not decode: the file is still decoded in full, so a 4h wav still takes minutes",
          ),
        windowStart: z
          .number()
          .min(0)
          .max(1)
          .default(0.5)
          .describe(
            "Where the window sits, as a fraction of the slack (0 = start, 0.5 = centred, 1 = end)",
          ),
        minLengthSec: z
          .number()
          .int()
          .min(0)
          .default(30)
          .describe(
            "Skip tracks shorter than this — interludes and skits have no stable tempo",
          ),
        maxLengthSec: z
          .number()
          .int()
          .min(0)
          .default(1200)
          .describe(
            "Skip tracks longer than this (0 = no cap). Multi-hour mixes and ambient have no single runnable tempo, cost minutes each to decode, and overflow essentia's RhythmExtractor2013 onset buffer — so they are excluded rather than analyzed",
          ),
        perFileTimeoutSec: z
          .number()
          .int()
          .min(0)
          .default(240)
          .describe(
            "Abort analysis of any single file after this many seconds and record it as failed (0 = no timeout). Guards against a huge file whose gonic length is 0/unknown slipping past maxLengthSec and hanging the whole batch",
          ),
        reanalyze: z
          .boolean()
          .default(false)
          .describe(
            "Re-analyze tracks already present in the previous run instead of carrying their results over",
          ),
        maxTracks: z
          .number()
          .int()
          .min(0)
          .default(50000)
          .describe(
            "Cap the tracks/failures arrays STORED in the resource (0 = no cap). Stats (median, histogram, confidence bands) are always computed over the FULL set before any truncation. Defaults high (unlike verify's 2000) because a low cap degrades bpm's resume carry-over and the `running` method's input — pass a smaller value only for test/debug runs, or 0 to guarantee full resume fidelity on a very large library",
          ),
      }),
      execute: async (args, context) => {
        const {
          host,
          sshUser,
          dbPath,
          containerMusicRoot,
          hostMusicRoot,
          bpmImage,
        } = context.globalArgs;
        const startedAt = new Date();
        const relOf = (cpath: string) =>
          cpath.startsWith(containerMusicRoot + "/")
            ? cpath.slice(containerMusicRoot.length + 1)
            : cpath;

        let files: { cpath: string; rel: string; lengthSec: number | null }[] =
          [];
        if (args.path) {
          const p = confineContainerPath(
            hostMusicRoot,
            containerMusicRoot,
            args.path,
          );
          files.push({ cpath: p, rel: relOf(p), lengthSec: null });
        } else {
          const rows = await sqliteJson(host, sshUser, dbPath, VERIFY_SQL);
          for (const row of rows) {
            const rel = (row.left_path || "") + row.right_path + "/" +
              row.filename;
            if (args.pathPrefix && !rel.startsWith(args.pathPrefix)) continue;
            files.push({
              cpath: containerMusicRoot + "/" + rel,
              rel,
              lengthSec: row.length || null,
            });
          }
        }

        const reportName = bpmResourceName(args.path, args.pathPrefix);

        // Resume: a whole-library pass runs for hours, so previously analyzed
        // tracks are carried over rather than recomputed unless asked. Prior
        // failures are carried too and treated as done — a file that failed
        // (corrupt, or too long for the beat tracker) is deterministic, so
        // retrying it every batch just re-decodes it for nothing and, for
        // multi-hour files, tanks the whole run.
        const carried: BpmTrack[] = [];
        const carriedFailures: BpmFailure[] = [];
        if (!args.reanalyze && context.readResource) {
          const prev = await context.readResource(reportName) as
            | { tracks?: BpmTrack[]; failures?: BpmFailure[] }
            | null;
          if (prev?.tracks?.length) carried.push(...prev.tracks);
          if (prev?.failures?.length) carriedFailures.push(...prev.failures);
        }
        const done = new Set([
          ...carried.map((t) => t.path),
          ...carriedFailures.map((f) => f.path),
        ]);
        if (done.size > 0) files = files.filter((f) => !done.has(f.rel));

        // Short tracks have no tempo worth trusting; a single explicit path is
        // always honored (the caller asked for that file by name).
        const beforeShort = files.length;
        if (!args.path && args.minLengthSec > 0) {
          files = files.filter(
            (f) => f.lengthSec === null || f.lengthSec >= args.minLengthSec,
          );
        }
        const skippedShort = beforeShort - files.length;

        // Very long files (mixes, ambient, hours-long rips) have no single
        // runnable tempo, cost minutes each to decode, and overflow essentia's
        // RhythmExtractor2013 onset buffer — skip them at the source.
        const beforeLong = files.length;
        if (!args.path && args.maxLengthSec > 0) {
          files = files.filter(
            (f) => f.lengthSec === null || f.lengthSec <= args.maxLengthSec,
          );
        }
        const skippedLong = beforeLong - files.length;

        // The python side reads one path per line, so a newline in a filename
        // would desynchronize the record stream.
        const safe = files.filter((f) =>
          !["\n", "\r"].some((c) => f.cpath.includes(c))
        );
        const skippedUnsafePaths = files.length - safe.length;
        const work = args.limit > 0 ? safe.slice(0, args.limit) : safe;

        const inner = `echo ${btoa(ANALYZE_PY)} | base64 -d > /tmp/a.py; ` +
          `exec python3 /tmp/a.py ${args.windowSec} ${args.windowStart} ${args.perFileTimeoutSec}`;
        const remoteCmd = `docker run --rm -i -v ${
          shQuote(`${hostMusicRoot}:${containerMusicRoot}:ro`)
        } --entrypoint sh ${shQuote(bpmImage)} -c ${shQuote(inner)}`;

        const workerCount = Math.min(
          args.concurrency,
          Math.max(1, work.length),
        );
        const chunks: typeof work[] = Array.from(
          { length: workerCount },
          () => [],
        );
        work.forEach((f, i) => chunks[i % workerCount].push(f));

        const outputs = await Promise.all(chunks.map((chunk) => {
          if (chunk.length === 0) return Promise.resolve("");
          const stdin = chunk.map((f) => f.cpath).join("\n") + "\n";
          return sshRun(host, sshUser, remoteCmd, stdin);
        }));

        const tracks: BpmTrack[] = [];
        const newFailures: BpmFailure[] = [];
        for (const out of outputs) {
          for (const line of out.split("\n")) {
            const { track, failure } = parseBpmLine(line, relOf);
            if (track) tracks.push(track);
            else if (failure) newFailures.push(failure);
          }
        }
        const missingRecords = work.length -
          (tracks.length + newFailures.length);
        const failures = [...carriedFailures, ...newFailures];

        const all = [...carried, ...tracks].sort((a, b) =>
          a.path < b.path ? -1 : a.path > b.path ? 1 : 0
        );
        const bpms = all
          .map((t) => t.bpm)
          .filter((b): b is number => b !== null)
          .sort((a, b) => a - b);
        const med = median(bpms);
        const bpmMedian = med === null ? null : Math.round(med * 100) / 100;
        const confidenceBands: Record<string, number> = {};
        for (const t of all) {
          confidenceBands[t.confidenceBand] =
            (confidenceBands[t.confidenceBand] ?? 0) + 1;
        }
        // realtime factor of the analyzers themselves, not of the whole run
        const audioSec = tracks.reduce((s, t) => s + (t.analyzedSec ?? 0), 0);
        const cpuSec = tracks.reduce((s, t) => s + (t.ms ?? 0), 0) / 1000;
        const analysisRateX = cpuSec > 0
          ? Math.round((audioSec / cpuSec) * 10) / 10
          : null;

        // Bound the STORED arrays (LB6) — stats above are already computed
        // over the FULL `all`/`failures` before this point, so a cap here
        // never affects bpmMedian/confidenceBands/bpmHistogram. Mirrors
        // verify's `problems: problemsTruncated ? problems.slice(0, 2000) :
        // problems`, but defaults far higher (see maxTracks' description):
        // capping the stored array low would degrade resume carry-over and
        // the `running` method's input on a library bigger than the cap.
        const tracksTruncated = args.maxTracks > 0 &&
          all.length > args.maxTracks;
        const storedTracks = tracksTruncated
          ? all.slice(0, args.maxTracks)
          : all;
        const failuresTruncated = args.maxTracks > 0 &&
          failures.length > args.maxTracks;
        const storedFailures = failuresTruncated
          ? failures.slice(0, args.maxTracks)
          : failures;

        const handle = await context.writeResource("bpm", reportName, {
          kind: "bpm",
          startedAt: startedAt.toISOString(),
          elapsedSec: Math.round((Date.now() - startedAt.getTime()) / 1000),
          params: {
            path: args.path,
            pathPrefix: args.pathPrefix,
            limit: args.limit,
            concurrency: args.concurrency,
            windowSec: args.windowSec,
            windowStart: args.windowStart,
            minLengthSec: args.minLengthSec,
            maxLengthSec: args.maxLengthSec,
            perFileTimeoutSec: args.perFileTimeoutSec,
            reanalyze: args.reanalyze,
            maxTracks: args.maxTracks,
          },
          analyzed: tracks.length,
          carriedOver: carried.length,
          failed: failures.length,
          newlyFailed: newFailures.length,
          skippedShort,
          skippedLong,
          skippedUnsafePaths,
          missingRecords,
          stats: {
            bpmMedian,
            confidenceBands,
            bpmHistogram: bpmHistogram(all),
            analysisRateX,
          },
          tracksTruncated,
          failuresTruncated,
          tracks: storedTracks,
          failures: storedFailures,
        });
        return { dataHandles: [handle] };
      },
    },

    running: {
      description:
        "Build a tunable running playlist from an existing bpm analysis: matches each track's tempo to your cadence at 1x/2x/half, gated on beat confidence so rubato and ambient never sneak in. Reads stored data — no audio is touched, so it is instant and re-tunable",
      arguments: z.object({
        pathPrefix: z
          .string()
          .default("")
          .describe(
            "Which bpm analysis to draw from — must match the pathPrefix the bpm method ran with (empty = whole-library analysis)",
          ),
        minSpm: z
          .number()
          .min(30)
          .max(300)
          .default(150)
          .describe("Slowest cadence you will run at, in steps per minute"),
        maxSpm: z
          .number()
          .min(30)
          .max(300)
          .default(190)
          .describe("Fastest cadence you will run at, in steps per minute"),
        minConfidence: z
          .number()
          .min(0)
          .max(5.32)
          .default(1.5)
          .describe(
            "Minimum essentia beat-detection confidence (0-5.32). Below ~1.5 the reported bpm is a grid laid over rubato or ambient material, not a pulse — lower this only if you want to see what was rejected",
          ),
        targetMin: z
          .number()
          .min(0)
          .default(0)
          .describe(
            "Trim the playlist to roughly this many minutes, keeping the strongest beats (0 = keep everything)",
          ),
        limit: z
          .number()
          .int()
          .min(0)
          .default(0)
          .describe("Cap the number of tracks (0 = no cap)"),
      }),
      execute: async (args, context) => {
        if (args.minSpm > args.maxSpm) {
          throw new Error(
            `minSpm (${args.minSpm}) is above maxSpm (${args.maxSpm}) — the cadence window is empty`,
          );
        }
        const source = bpmResourceName("", args.pathPrefix);
        if (!context.readResource) {
          throw new Error("readResource unavailable — cannot load bpm data");
        }
        const bpm = await context.readResource(source) as
          | { tracks?: RunTrack[] }
          | null;
        if (!bpm?.tracks?.length) {
          throw new Error(
            `No bpm analysis found at "${source}" — run: swamp model method run ${context.definition.name} bpm` +
              (args.pathPrefix
                ? ` --input pathPrefix="${args.pathPrefix}"`
                : ""),
          );
        }

        const r = buildRunning(bpm.tracks, {
          minSpm: args.minSpm,
          maxSpm: args.maxSpm,
          minConfidence: args.minConfidence,
          targetMin: args.targetMin,
          limit: args.limit,
        });

        const scope = args.pathPrefix ? slugify(args.pathPrefix) : "library";
        const name = `running-${scope}-${Math.round(args.minSpm)}-${
          Math.round(args.maxSpm)
        }`;
        const handle = await context.writeResource("playlist", name, {
          kind: "playlist",
          generatedAt: new Date().toISOString(),
          source,
          sourceAnalyzed: bpm.tracks.length,
          params: {
            pathPrefix: args.pathPrefix,
            minSpm: args.minSpm,
            maxSpm: args.maxSpm,
            minConfidence: args.minConfidence,
            targetMin: args.targetMin,
            limit: args.limit,
          },
          tracksTotal: r.playlist.length,
          eligible: r.eligible,
          excluded: r.excluded,
          totalSec: Math.round(r.totalSec),
          buckets: r.buckets,
          albums: r.albums,
          tracks: r.playlist,
        });
        return { dataHandles: [handle] };
      },
    },

    probe: {
      description:
        "Deep-probe one file with ffprobe (inside the container): full tags in all encodings, codec, sample rate — for debugging tag/encoding issues",
      arguments: z.object({
        path: z
          .string()
          .describe(
            "File path: library-relative, or absolute host/container path",
          ),
      }),
      execute: async (args, context) => {
        const {
          host,
          sshUser,
          container,
          containerMusicRoot,
          hostMusicRoot,
          legacyEncodings,
        } = context.globalArgs;
        const allowed = new Set<string>(legacyEncodings);

        const p = confineContainerPath(
          hostMusicRoot,
          containerMusicRoot,
          args.path,
        );

        const out = await sshRun(
          host,
          sshUser,
          `docker exec ${shQuote(container)} ffprobe -v quiet ` +
            `-print_format json -show_format -show_streams ${shQuote(p)}`,
        );
        if (!out.trim()) {
          throw new Error(
            `ffprobe returned no output for ${args.path} — the file may not exist inside the container, or ffprobe crashed silently`,
          );
        }
        let probe;
        try {
          probe = JSON.parse(out);
        } catch {
          throw new Error(
            `ffprobe returned invalid JSON for ${args.path} — output was not parseable`,
          );
        }
        const audioStream = (probe.streams || []).find(
          (s) => s.codec_type === "audio",
        ) || null;

        // merge format-level and stream-level tags (ogg/opus use the latter)
        const rawTags: Record<string, string> = {};
        for (
          const [k, v] of [
            ...Object.entries(probe.format?.tags || {}),
            ...Object.entries(audioStream?.tags || {}),
          ]
        ) {
          rawTags[k.toLowerCase()] = String(v);
        }

        const encodingTrace: {
          field: string;
          before: string;
          after: string;
          encoding: string | null;
        }[] = [];
        const tags: Record<string, string> = {};
        for (const [k, v] of Object.entries(rawTags)) {
          const r = fixEncoding(v, 0, allowed);
          tags[k] = r.value;
          if (r.fixed) {
            encodingTrace.push({
              field: k,
              before: v,
              after: r.value,
              encoding: r.encoding,
            });
          }
        }

        const handle = await context.writeResource(
          "probe",
          `probe-${slugify(p.split("/").pop() || p)}-${hash8(p)}`,
          {
            kind: "probe",
            path: args.path,
            containerPath: p,
            format: probe.format || null,
            audioStream,
            tags,
            encodingTrace,
            probedAt: new Date().toISOString(),
          },
        );
        return { dataHandles: [handle] };
      },
    },

    "resolve-artists": {
      description:
        "Build a cached artist-name to MusicBrainz-ID map: seeds from the headphones instance's artist list, falls back to ONE batched MusicBrainz search (search-artists-batch) for every library artist the seed doesn't cover, and parks ambiguous or unresolved artists for human review instead of guessing. A prior run's map is reused for up to ttlMs (default 30 days) per seed-unresolved artist, so a converged re-run costs zero MusicBrainz requests; pendingSearch/truncated/stopReason on the written map say whether this run converged or was cut short by maxQueries/maxDurationMs/an abort/a backoff.",
      arguments: z.object({
        headphonesInstance: z
          .string()
          .default("headphones")
          .describe(
            "swamp model instance name providing the headphones artist seed (spec: artists)",
          ),
        musicbrainzInstance: z
          .string()
          .default("musicbrainz")
          .describe(
            "swamp model instance name used for the MusicBrainz artist search fallback (search-artists-batch)",
          ),
        refresh: z
          .boolean()
          .default(false)
          .describe(
            "Re-search every seed-unresolved artist this run, ignoring the reuse-cache TTL entirely",
          ),
        refreshKeys: z
          .array(z.string())
          .default([])
          .describe(
            "Force a re-search for these specific artistKeys even if their cached verdict is still fresh — ordered FIRST in the batch so the maxQueries ceiling can never discard an explicitly requested re-check",
          ),
        ttlMs: z
          .number()
          .default(2_592_000_000)
          .describe(
            "Reuse-cache TTL in milliseconds: a seed-unresolved artist whose prior verdict is younger than this is reused without a fresh search (default 30 days)",
          ),
        maxQueries: z
          .number()
          .default(400)
          .describe(
            "Max distinct MusicBrainz queries issued to search-artists-batch this run before the remainder is deferred to a future run — passed straight through to that method's own maxQueries",
          ),
        maxDurationMs: z
          .number()
          .optional()
          .describe(
            "Wall-clock ceiling passed through to search-artists-batch; when omitted, that method derives one from maxQueries so raising the ceiling also raises the backstop",
          ),
      }),
      execute: async (args, context) => {
        const now = Date.now();

        // seed: every headphones artist becomes a match candidate, keyed
        // by ArtistID/ArtistName — the SAME shape matchArtist expects from
        // a MusicBrainz search result, so both pass through one function.
        const headphonesRows = await readRows(
          context,
          args.headphonesInstance,
          "artists",
        );
        const seedCandidates: Candidate[] = [];
        for (const row of headphonesRows) {
          const list = rowAttrs(row).artists;
          if (!Array.isArray(list)) continue;
          for (const a of list as Record<string, unknown>[]) {
            const id = typeof a?.ArtistID === "string" ? a.ArtistID : null;
            const name = typeof a?.ArtistName === "string"
              ? a.ArtistName
              : null;
            if (id && name) seedCandidates.push({ id, name });
          }
        }

        // the artists NEEDING resolution: this model's own artist
        // dimension (scan's output), not merely the seed's coverage.
        // Deduped into an ORDERED key list — this is the library order
        // every downstream structure (finalEntries, the written entries[])
        // is built against, and rule 7 ("only artists present in the
        // library are written") falls out of iterating THIS list, never
        // the prior map's.
        const libraryRows = await readRows(
          context,
          context.definition.name,
          "artist",
        );
        const libraryOrder: string[] = [];
        const libraryNameByKey = new Map<string, string>();
        for (const row of libraryRows) {
          const attrs = rowAttrs(row);
          const artistKey = typeof attrs.key === "string" ? attrs.key : null;
          const artistName = typeof attrs.name === "string" ? attrs.name : null;
          if (!artistKey || !artistName) continue;
          if (!libraryNameByKey.has(artistKey)) libraryOrder.push(artistKey);
          libraryNameByKey.set(artistKey, artistName);
        }

        // LOAD: the prior run's map, indexed by artistKey (step 10).
        const priorMap = await readPriorArtistMap(context, "artist-map");

        // PASS 1 — classify every library artist: a FINAL entry now (seed
        // match, or a fresh-enough prior reused verbatim), or a query
        // pending a search this run. `checkedAt` is left UNSET on every
        // seed match here — rule (4): a seed match is never a search
        // verdict, so it never carries a search-freshness stamp.
        const refreshKeysSet = new Set(args.refreshKeys);
        const finalEntries = new Map<string, ArtistMapEntry>();
        const pendingByKey = new Map<
          string,
          { artistName: string; query: string }
        >();

        // Declared here (rather than beside the runModel call below) so
        // PASS 1's own abort check can set them too.
        let pendingSearch = 0;
        let truncated = false;
        let stopReason: string | null = null;
        let pass1Aborted = false;

        for (let i = 0; i < libraryOrder.length; i++) {
          if (context.signal?.aborted) {
            // Mirrors search-artists-batch's own abort check
            // (musicbrainz.ts) — stop spending CPU on matchArtist for the
            // rest of a large library the moment the caller cancels,
            // rather than inventing a new stop pattern here. Every
            // artistKey the WRITE step below still needs an entry for
            // (`finalEntries.get(artistKey)!` is a non-null assertion) is
            // filled in by the fallback sweep right after this loop, using
            // the SAME prior-reuse-or-unresolved rule PASS 2 already
            // applies to a query that never got a verdict.
            pass1Aborted = true;
            stopReason = "aborted";
            break;
          }
          const artistKey = libraryOrder[i];
          const artistName = libraryNameByKey.get(artistKey)!;
          const seedMatch = matchArtist(artistName, seedCandidates);

          if (seedMatch.kind === "resolved") {
            finalEntries.set(artistKey, {
              artistKey,
              artistName,
              mbid: seedMatch.mbid,
              status: "resolved",
              source: "seed",
              candidates: [],
            });
            continue;
          }
          if (seedMatch.kind === "ambiguous") {
            // ambiguous in the seed is parked, never disambiguated by a
            // search — the collision is in the name itself.
            finalEntries.set(artistKey, {
              artistKey,
              artistName,
              mbid: null,
              status: "ambiguous",
              source: null,
              candidates: seedMatch.candidates.map((c) => ({
                id: c.id,
                name: c.name,
              })),
            });
            continue;
          }

          // seed-unresolved: reuse the prior verdict if it is still fresh
          // and neither refresh nor refreshKeys forces a re-check.
          const prior = priorMap.get(artistKey);
          const forced = args.refresh || refreshKeysSet.has(artistKey);
          if (!forced && !needsSearch(prior, now, args.ttlMs)) {
            finalEntries.set(artistKey, {
              artistKey,
              artistName,
              mbid: prior!.mbid,
              status: prior!.status,
              source: prior!.source,
              candidates: prior!.candidates,
              checkedAt: prior!.checkedAt,
            });
            continue;
          }

          pendingByKey.set(artistKey, {
            artistName,
            query: `artist:"${escapeLuceneQuery(artistName)}"`,
          });
        }

        // PASS 1 was cut short by the abort check above — every artistKey
        // that still has no finalEntries record (whether PASS 1 never
        // reached it, or reached it and only got as far as pendingByKey)
        // falls back to its prior verdict, or unresolved with no prior.
        // Skipping the batch call below (not just this classification
        // loop) matters too: an aborted caller must not still pay for a
        // search-artists-batch invocation it already asked to cancel.
        if (pass1Aborted) {
          for (const artistKey of libraryOrder) {
            if (finalEntries.has(artistKey)) continue;
            const artistName = libraryNameByKey.get(artistKey)!;
            const prior = priorMap.get(artistKey);
            pendingSearch++;
            finalEntries.set(
              artistKey,
              prior
                ? {
                  artistKey,
                  artistName,
                  mbid: prior.mbid,
                  status: prior.status,
                  source: prior.source,
                  candidates: prior.candidates,
                  checkedAt: prior.checkedAt,
                }
                : {
                  artistKey,
                  artistName,
                  mbid: null,
                  status: "unresolved",
                  source: null,
                  candidates: [],
                },
            );
          }
          truncated = true;
        }

        // Order pending artists with refreshKeys members FIRST, in the
        // order the caller gave them, then every other artist needing a
        // search in LIBRARY order (rule 8) — so search-artists-batch's own
        // maxQueries cut can never discard an explicitly requested
        // re-check. Distinct QUERY STRINGS (order-preserved) are what
        // actually go to musicbrainz; duplicate names collapse onto one
        // query via `pendingByKey`, resolvable on the way back per key.
        const orderedKeys: string[] = [];
        const seenKeys = new Set<string>();
        for (const key of args.refreshKeys) {
          if (pendingByKey.has(key) && !seenKeys.has(key)) {
            orderedKeys.push(key);
            seenKeys.add(key);
          }
        }
        for (const key of libraryOrder) {
          if (pendingByKey.has(key) && !seenKeys.has(key)) {
            orderedKeys.push(key);
            seenKeys.add(key);
          }
        }

        const queries: string[] = [];
        const seenQueries = new Set<string>();
        for (const key of orderedKeys) {
          const q = pendingByKey.get(key)!.query;
          if (!seenQueries.has(q)) {
            queries.push(q);
            seenQueries.add(q);
          }
        }

        // Zero names needing a search -> zero runModel calls (the fix's
        // headline invariant: N artists never means N invocations, and
        // when nothing needs asking, it means ZERO). Also skipped
        // entirely when PASS 1 above was aborted — see the fallback sweep
        // just after that loop.
        if (!pass1Aborted && queries.length > 0) {
          if (!context.runModel) {
            throw new Error(
              "runModel unavailable — cannot search MusicBrainz for unresolved artists",
            );
          }
          const batchId = crypto.randomUUID();
          // Exactly ONE runModel call per run, on purpose (see the fix
          // description on this method's registration below): MusicBrainz's
          // rate limiter (mbFetch's module-level `lastRequest`) has no
          // memory across separate context.runModel invocations, so its
          // very first request in each invocation still fires with
          // `lastRequest === null` — no wait at all. Batching every
          // seed-unresolved artist into ONE search-artists-batch call is
          // what keeps that free first request to ONE per run instead of
          // one per artist (~1483 in the run that surfaced this bug,
          // pushing real traffic to ~2.5 req/sec against the documented 1
          // req/sec limit). Re-introducing a per-artist `for` loop around
          // `context.runModel` here — even just for the ones this batch
          // left in `deferred[]` — would reintroduce that exact defect.
          // Pinned by "a truncated batch is NOT finished by looping
          // runModel" in music_library_methods_test.ts.
          await context.runModel({
            definition: args.musicbrainzInstance,
            method: "search-artists-batch",
            arguments: {
              queries,
              batchId,
              // Explicit 25, NOT search-artists-batch's own default of 10.
              // The deleted per-artist path called search-artist with no
              // `limit`, so MusicBrainz applied its /ws/2 default of 25
              // candidates; matchArtist (artist_match.ts) needs the FULL
              // candidate set to tell a genuine ambiguous duplicate apart
              // from a single resolved match — a duplicate MBID ranked
              // 11-25 would otherwise fall outside search-artists-batch's
              // default window and this method would auto-pick a single
              // `resolved` MBID instead of correctly parking the artist as
              // `ambiguous`. search-artists-batch's own default of 10 stays
              // 10 for its other callers — this override belongs at the
              // call site that regressed, not upstream.
              limit: 25,
              maxQueries: args.maxQueries,
              ...(args.maxDurationMs !== undefined
                ? { maxDurationMs: args.maxDurationMs }
                : {}),
            },
          });

          const batchRows = await readRows(
            context,
            args.musicbrainzInstance,
            "artistSearchBatch",
          );
          const batchAttrs = selectBatchRow(
            batchRows,
            batchId,
            args.musicbrainzInstance,
          );

          const batchQueryRows = Array.isArray(batchAttrs.queries)
            ? (batchAttrs.queries as Record<string, unknown>[])
            : [];
          stopReason = typeof batchAttrs.stopReason === "string"
            ? batchAttrs.stopReason
            : null;
          const batchTimestamp = typeof batchAttrs.timestamp === "string"
            ? batchAttrs.timestamp
            : new Date().toISOString();

          const resultByQuery = new Map<string, Record<string, unknown>>();
          for (const qr of batchQueryRows) {
            if (typeof qr.query === "string") resultByQuery.set(qr.query, qr);
          }

          // PASS 2 — resolve every pending artist against its query's
          // result. A query present with no `error` -> matched (including
          // a genuine no-match, which still gets a fresh checkedAt). A
          // query with an `error`, or ABSENT from queries[] (including
          // everything deferred), preserves the PRIOR verdict unchanged —
          // `checkedAt` stays at its prior value (still stale, so the next
          // run retries), and with no prior at all: unresolved, checkedAt
          // UNSET. Never set for anything but a genuine search verdict —
          // identical to the seed rule above (rule 3 = rule 4).
          let pass2Aborted = false;
          for (let i = 0; i < orderedKeys.length; i++) {
            if (context.signal?.aborted) {
              // Mirrors search-artists-batch's own abort check — stop
              // scoring the remaining candidates against matchArtist
              // immediately. The fallback sweep right after this loop
              // treats every artist this run didn't reach exactly like a
              // query that came back with an error or landed in
              // deferred[]: preserve its prior verdict, or unresolved with
              // no prior.
              pass2Aborted = true;
              stopReason = "aborted";
              break;
            }
            const artistKey = orderedKeys[i];
            const pending = pendingByKey.get(artistKey)!;
            const result = resultByQuery.get(pending.query);
            const prior = priorMap.get(artistKey);

            if (result && result.error === undefined) {
              const rawArtists = Array.isArray(result.artists)
                ? (result.artists as Record<string, unknown>[])
                : [];
              const candidates: Candidate[] = [];
              for (const a of rawArtists) {
                if (typeof a.id === "string" && typeof a.name === "string") {
                  candidates.push({
                    id: a.id,
                    name: a.name,
                    sortName: typeof a["sort-name"] === "string"
                      ? (a["sort-name"] as string)
                      : undefined,
                  });
                }
              }
              const match = matchArtist(pending.artistName, candidates);
              let status: ArtistMapEntry["status"] = "unresolved";
              let mbid: string | null = null;
              let matchCandidates: { id: string; name: string }[] = [];
              if (match.kind === "resolved") {
                status = "resolved";
                mbid = match.mbid;
              } else if (match.kind === "ambiguous") {
                status = "ambiguous";
                matchCandidates = match.candidates.map((c) => ({
                  id: c.id,
                  name: c.name,
                }));
              }
              finalEntries.set(artistKey, {
                artistKey,
                artistName: pending.artistName,
                mbid,
                status,
                source: "search",
                candidates: matchCandidates,
                checkedAt: batchTimestamp,
              });
              continue;
            }

            // error, absent from queries[], or listed in deferred[] — that
            // query never got a verdict this run.
            pendingSearch++;
            if (prior) {
              finalEntries.set(artistKey, {
                artistKey,
                artistName: pending.artistName,
                mbid: prior.mbid,
                status: prior.status,
                source: prior.source,
                candidates: prior.candidates,
                checkedAt: prior.checkedAt,
              });
            } else {
              finalEntries.set(artistKey, {
                artistKey,
                artistName: pending.artistName,
                mbid: null,
                status: "unresolved",
                source: null,
                candidates: [],
              });
            }
          }

          if (pass2Aborted) {
            for (const artistKey of orderedKeys) {
              if (finalEntries.has(artistKey)) continue;
              const pending = pendingByKey.get(artistKey)!;
              const prior = priorMap.get(artistKey);
              pendingSearch++;
              finalEntries.set(
                artistKey,
                prior
                  ? {
                    artistKey,
                    artistName: pending.artistName,
                    mbid: prior.mbid,
                    status: prior.status,
                    source: prior.source,
                    candidates: prior.candidates,
                    checkedAt: prior.checkedAt,
                  }
                  : {
                    artistKey,
                    artistName: pending.artistName,
                    mbid: null,
                    status: "unresolved",
                    source: null,
                    candidates: [],
                  },
              );
            }
          }

          truncated = pendingSearch > 0;
        }

        // WRITE: only artists present in the LIBRARY are written, in
        // library order — an entry in the prior map whose artist is no
        // longer in the library is dropped here by construction (rule 7).
        const entries: ArtistMapEntry[] = [];
        let resolved = 0;
        let ambiguous = 0;
        let unresolved = 0;
        for (const artistKey of libraryOrder) {
          const entry = finalEntries.get(artistKey)!;
          entries.push(entry);
          if (entry.status === "resolved") resolved++;
          else if (entry.status === "ambiguous") ambiguous++;
          else unresolved++;
        }

        const handle = await context.writeResource("artistMap", "artist-map", {
          kind: "artistMap",
          scannedAt: new Date().toISOString(),
          params: {
            headphonesInstance: args.headphonesInstance,
            musicbrainzInstance: args.musicbrainzInstance,
          },
          resolved,
          ambiguous,
          unresolved,
          entries,
          pendingSearch,
          truncated,
          stopReason,
        });
        return { dataHandles: [handle] };
      },
    },

    wanted: {
      description:
        "Pure derivation of the want-set (no network): diffs the MusicBrainz browse cache against the owned library cube via deriveWanted, using the artistMap resolve-artists wrote to identify each artist",
      arguments: z.object({
        artistMapName: z
          .string()
          .default("artist-map")
          .describe("Name of the artistMap resource resolve-artists wrote"),
        musicbrainzInstance: z
          .string()
          .default("musicbrainz")
          .describe(
            "swamp model instance name providing the MusicBrainz release-group browse cache (spec: browse)",
          ),
        targetQuality: z
          .enum(["lossless", "lossy-high", "lossy-mid", "lossy-low", "unknown"])
          .default("lossless")
          .describe(
            "Minimum quality bucket before an owned album counts as an upgrade want",
          ),
        uncertainMatchPresent: z
          .boolean()
          .default(true)
          .describe(
            "Whether an uncertain title match against the owned cube counts as present (no want) or missing",
          ),
      }),
      execute: async (args, context) => {
        if (!context.readResource) {
          throw new Error(
            "readResource unavailable — cannot load the artistMap resource",
          );
        }
        const artistMap = await context.readResource(args.artistMapName) as
          | { entries?: unknown }
          | null;
        const mapEntries = Array.isArray(artistMap?.entries)
          ? (artistMap.entries as Array<Record<string, unknown>>)
          : null;
        if (!mapEntries) {
          throw new Error(
            `No artistMap found at "${args.artistMapName}" — run: ` +
              `swamp model method run ${context.definition.name} resolve-artists`,
          );
        }

        const browseRows = await readRows(
          context,
          args.musicbrainzInstance,
          "browse",
        );
        if (browseRows.length === 0) {
          throw new Error(
            `No MusicBrainz browse cache found for instance "${args.musicbrainzInstance}" — nothing has been synced yet, so no want set can be derived.\n` +
              `Run: swamp model method run ${args.musicbrainzInstance} sync-artist-discographies --input 'artistMbids:json=["<mbid>","<mbid>"]' (about 1 request/sec — a cold pass over ~775 artists is ~35 minutes and prints nothing until it finishes)\n` +
              `Get the list from this instance's own artistMap: swamp data query 'modelName == "${context.definition.name}" && name == "${args.artistMapName}" && isLatest' --select 'attributes.entries.filter(e, e.status == "resolved").map(e, e.mbid)' --json — that prints a query envelope, {"results": [[...the MBIDs...]], "total": 1}; pass the single element of "results" as the artistMbids array, not the whole document\n` +
              `Shipped as extensions/workflows/music-wanted.yaml (@magistr/music-wanted-sequence) — create it with swamp workflow create, paste the body in, and invoke it under the name you gave it; the author's own copy runs swamp workflow run music-wanted`,
          );
        }

        const resolvedArtists: ResolvedArtist[] = [];
        for (const e of mapEntries) {
          if (
            e.status === "resolved" &&
            typeof e.mbid === "string" &&
            typeof e.artistKey === "string" &&
            typeof e.artistName === "string"
          ) {
            resolvedArtists.push({
              artistKey: e.artistKey,
              artistName: e.artistName,
              mbid: e.mbid,
            });
          }
        }

        // desired discography per resolved artist, keyed by artistKey (not
        // mbid) — browse rows carry HYPHENATED MusicBrainz field names.
        const desired: Record<string, DesiredReleaseGroup[]> = {};
        for (const a of resolvedArtists) {
          const groups: DesiredReleaseGroup[] = [];
          for (const row of browseRows) {
            const attrs = rowAttrs(row);
            if (attrs.linkedId !== a.mbid) continue;
            const results = Array.isArray(attrs.results) ? attrs.results : [];
            for (const r of results as Record<string, unknown>[]) {
              if (typeof r?.id !== "string" || typeof r?.title !== "string") {
                continue;
              }
              groups.push({
                id: r.id,
                title: r.title,
                primaryType: typeof r["primary-type"] === "string"
                  ? (r["primary-type"] as string)
                  : null,
                secondaryTypes: Array.isArray(r["secondary-types"])
                  ? (r["secondary-types"] as string[])
                  : [],
                firstReleaseDate: typeof r["first-release-date"] === "string"
                  ? (r["first-release-date"] as string)
                  : null,
              });
            }
          }
          desired[a.artistKey] = groups;
        }

        // owned cube: this model's own album facts, joined to a resolved
        // artistKey by normalized artist NAME (albums carry the artist
        // name, not the artistMap's opaque key).
        const artistKeyByNormName = new Map<string, string>();
        for (const a of resolvedArtists) {
          artistKeyByNormName.set(normArtistKey(a.artistName), a.artistKey);
        }
        const albumRows = await readRows(
          context,
          context.definition.name,
          "album",
        );
        const owned: OwnedAlbum[] = [];
        for (const row of albumRows) {
          const attrs = rowAttrs(row);
          const artistName = typeof attrs.artist === "string"
            ? attrs.artist
            : null;
          const title = typeof attrs.title === "string" ? attrs.title : null;
          if (!artistName || !title) continue;
          const artistKey = artistKeyByNormName.get(
            normArtistKey(artistName),
          );
          if (!artistKey) continue;
          owned.push({
            artistKey,
            title,
            year: typeof attrs.year === "number" ? attrs.year : null,
            qualityBucket: albumQualityBucket(attrs.tracks),
          });
        }

        const now = new Date().toISOString();
        const { wants } = deriveWanted(
          { artists: resolvedArtists, desired, owned },
          {
            now,
            targetQuality: args.targetQuality,
            uncertainMatchPresent: args.uncertainMatchPresent,
          },
        );

        const handle = await context.writeResource("wanted", "wanted", {
          kind: "wanted",
          generatedAt: now,
          params: {
            artistMapName: args.artistMapName,
            musicbrainzInstance: args.musicbrainzInstance,
            targetQuality: args.targetQuality,
            uncertainMatchPresent: args.uncertainMatchPresent,
          },
          total: wants.length,
          missing: wants.filter((w) => w.kind === "missing").length,
          upgrade: wants.filter((w) => w.kind === "upgrade").length,
          wants,
        });
        return { dataHandles: [handle] };
      },
    },
  },
};
