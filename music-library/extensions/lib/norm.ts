// Pure title/artist normalisation domain logic — shared by the music_library
// model (dirname parsing via stripNoise, duplicate detection via
// normDupeKey) and the wanted-derivation pipeline's title matching
// (deriveWanted, via normDupeKey). Pure — no I/O, no zod, dependency-free.

// --- Noise-group detection (format tags, bitrates, catalog codes, …) ---

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

/**
 * True when every word in `content` is release/quality noise — used to
 * decide whether a bracket group like "(FLAC)" or "(Remastered)" should be
 * dropped entirely.
 */
export function isNoiseGroup(content: string): boolean {
  const words = content.split(/[\s,/]+/).filter((w) => w.length > 0);
  if (words.length === 0) return true;
  return words.every((w) => NOISE_WORD_RE.test(w));
}

// --- Duplicate-matching title/artist normalisation ---

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
