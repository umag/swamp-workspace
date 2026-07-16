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
  legacyEncodings: z
    .array(z.string())
    .default(["windows-1251", "koi8-r", "ibm866", "shift_jis", "gbk"])
    .describe(
      "Charsets tag-encoding recovery may re-decode, in preference order (jschardet names)",
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
): Promise<string> {
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
      `${sshUser}@${host}`,
      command,
    ],
    stdin: stdinText === undefined ? "null" : "piped",
    stdout: "piped",
    stderr: "piped",
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

// Charsets the recovery is willing to re-decode by default. Anything else
// jschardet suggests is ignored unless explicitly allowed via the
// `legacyEncodings` global argument.
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

const NOISE_WORD_RE = new RegExp(
  "^(?:" +
    [
      "(?:16|24)[\\s\\-/]?(?:bit)?[\\s\\-/]?(?:44|48|88\\.?2?|96|176|192)(?:khz)?",
      "flac",
      "ape",
      "wv",
      "wav",
      "mp3",
      "aac",
      "ogg",
      "opus",
      "m4a",
      "alac",
      "dsd\\d*",
      "web",
      "cd",
      "cdm",
      "cdrip",
      "vinyl",
      "lp",
      "tape",
      "promo",
      "single",
      "ep",
      "album",
      "comp(?:ilation)?",
      "remaster(?:ed)?",
      "reissue",
      "deluxe",
      "limited",
      "expanded",
      "bonus",
      "japan(?:ese)?",
      "scans?",
      "covers?",
      "cue",
      "log",
      "lossless",
      "hdcd",
      "sacd",
      "mfsl",
      "super",
      "edition",
      "digipak",
      "\\d{2,4}\\s?kbps",
      "320",
      "256",
      "224",
      "192",
      "160",
      "128",
      "vbr",
      "cbr",
      "v0",
      "v2",
      "(?:cd|disc|disk)\\s?\\d+",
      "\\d+cd",
      "[a-z]{2,6}[- ]?\\d{2,8}", // catalog codes: VICP-61465, LFTFLD21
      "\\d{2,4}-\\d{2,6}", // catalog numbers: 08-1488
    ].join("|") +
    ")$",
  "i",
);

const DISC_DIR_RE = /^(?:cd|disc|disk|part|vol(?:ume)?)[\s._-]*(\d{1,2})$/i;

function isNoiseGroup(content: string): boolean {
  const words = content.split(/[\s,/]+/).filter((w) => w.length > 0);
  if (words.length === 0) return true;
  return words.every((w) => NOISE_WORD_RE.test(w));
}

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

// Words ignored when normalizing titles for duplicate matching.
const NORM_NOISE = new Set([
  "remaster",
  "remastered",
  "reissue",
  "deluxe",
  "edition",
  "expanded",
  "bonus",
  "limited",
  "special",
  "anniversary",
  "version",
  "edit",
  "disc",
  "disk",
  "cd",
  "lp",
  "vinyl",
  "mono",
  "stereo",
]);

/**
 * Normalize an artist/title for duplicate matching. Bracket groups are
 * dropped only when their content is release noise — "(Remastered)" goes,
 * "(Part One)" stays, so multi-part releases do not conflate.
 */
export function normDupeKey(s: string): string {
  let t = s.toLowerCase().normalize("NFKD").replace(/\p{M}/gu, "");
  t = t.replace(
    /[([{]([^()[\]{}]*)[)\]}]/g,
    (_m, content) => isNoiseGroup(content) ? " " : ` ${content} `,
  );
  t = t.replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  t = t.split(" ").filter((w) => w && !NORM_NOISE.has(w)).join(" ");
  return t;
}

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

// --- Model ---

/**
 * Multidimensional music library catalog: album facts, artist/genre/year/
 * format/quality dimensions, and data-quality worklists, built from the gonic
 * scan index (no filesystem traversal) with tag-encoding recovery and
 * directory-naming fallback.
 */
export const model = {
  type: "@magistr/music-library",
  version: "2026.07.07.1",
  reports: ["@magistr/music-verify-triage"],
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
    probe: {
      description: "Deep ffprobe result for a single file",
      schema: ProbeSchema,
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
        } = context.globalArgs;
        const startedAt = new Date();

        // work list: container path + expected duration from the index
        let files: {
          cpath: string;
          rel: string;
          expectedSec: number | null;
        }[] = [];
        if (args.path) {
          let p = args.path;
          if (p.startsWith(hostMusicRoot + "/")) {
            p = containerMusicRoot + p.slice(hostMusicRoot.length);
          } else if (!p.startsWith(containerMusicRoot + "/")) {
            p = containerMusicRoot + "/" + p.replace(/^\/+/, "");
          }
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
        const fullScript =
          'while IFS= read -r f; do out=$(ffmpeg -nostdin -v error -stats -i "$f" -map 0:a -f null - 2>&1); rc=$?; printf "%s\\037%s\\037%s\\036" "$f" "$rc" "$out"; done';
        // default IFS here: the first word is the seek offset, the rest of
        // the line (spaces included) lands in $f
        const quickScript =
          'while read -r off f; do out=$(ffmpeg -nostdin -v error -stats -ss "$off" -i "$f" -map 0:a -f null - 2>&1); rc=$?; printf "%s\\037%s\\037%s\\036" "$f" "$rc" "$out"; done';
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
          return sshRun(host, sshUser, remoteCmd, stdin);
        }));

        const byPath = new Map(safe.map((f) => [f.cpath, f]));
        const seen = new Set<string>();
        let okCount = 0;
        let failedCount = 0;
        let errorsCount = 0;
        let truncatedCount = 0;
        const problems: VerifyProblem[] = [];
        for (const out of outputs) {
          for (const rec of out.split("\x1e")) {
            if (!rec.trim()) continue;
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

        let p = args.path;
        if (p.startsWith(hostMusicRoot + "/")) {
          p = containerMusicRoot + p.slice(hostMusicRoot.length);
        } else if (!p.startsWith(containerMusicRoot + "/")) {
          p = containerMusicRoot + "/" + p.replace(/^\/+/, "");
        }

        const out = await sshRun(
          host,
          sshUser,
          `docker exec ${shQuote(container)} ffprobe -v quiet ` +
            `-print_format json -show_format -show_streams ${shQuote(p)}`,
        );
        const probe = JSON.parse(out);
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
  },
};
