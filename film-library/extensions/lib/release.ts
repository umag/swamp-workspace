// Release-name parsing for film files and directories.
//
// Turns names as they occur on a real share —
//   "400.Days.2015.1080p.BluRay.X264-DEFLATE.mkv"
//   "12 разгневанных мужчин (1957. 12 Angry Men) BDRip 1080p.mkv"
//   "1080p_Forrest_Gump_1994.mkv"
//   "Ame Agaru-(1999)-After The Rain-DIVX"
//   "Blackadder - Черная гадюка.1983-1999 [act.Rowan Atkinson]"
// — into a title, alternative titles, a year, and the technical tags
// (resolution, source, codec, HDR, audio, streaming service, edition,
// language tags, release group, series/episode markers).
//
// Pure functions only: no I/O, no swamp context.

export type ReleaseInfo = {
  title: string;
  altTitles: string[];
  year: number | null;
  yearEnd: number | null;
  edition: string | null;
  resolution: string | null;
  source: string | null;
  codec: string | null;
  hdr: string[];
  audio: string[];
  service: string | null;
  langTags: string[];
  group: string | null;
  is3D: boolean;
  season: number | null;
  episode: number | null;
  isSeries: boolean;
  part: number | null;
  suspectTitle: boolean;
};

export const VIDEO_EXTS = new Set([
  "mkv",
  "mp4",
  "avi",
  "m4v",
  "mov",
  "wmv",
  "ts",
  "m2ts",
  "mts",
  "mpg",
  "mpeg",
  "vob",
  "webm",
  "divx",
  "flv",
  "ogm",
  "rmvb",
  "iso",
]);

export const SUBTITLE_EXTS = new Set([
  "srt",
  "sub",
  "idx",
  "ass",
  "ssa",
  "vtt",
  "sup",
]);

/** Lower-case extension of a file name ("" when none). */
export function extOf(name: string): string {
  const i = name.lastIndexOf(".");
  if (i <= 0 || i === name.length - 1) return "";
  const e = name.slice(i + 1).toLowerCase();
  return /^[a-z0-9]{1,5}$/.test(e) ? e : "";
}

/** Name without a recognised media/subtitle extension. */
export function stripExt(name: string): string {
  const e = extOf(name);
  return e && (VIDEO_EXTS.has(e) || SUBTITLE_EXTS.has(e) || e === "nfo")
    ? name.slice(0, -(e.length + 1))
    : name;
}

const CURRENT_YEAR_MAX = 2100;

/** True for a plausible release year (1888 — first film — to 2100). */
export function isYear(s: string): boolean {
  if (!/^(18|19|20)\d\d$/.test(s)) return false;
  const n = Number(s);
  return n >= 1888 && n <= CURRENT_YEAR_MAX;
}

// --- Tag vocabularies -------------------------------------------------------

type Rule = [RegExp, string];

const RESOLUTION: Rule[] = [
  [/^(2160p|4k|uhd)$/i, "2160p"],
  [/^1080[pi]$/i, "1080p"],
  [/^720p$/i, "720p"],
  [/^576p$/i, "576p"],
  [/^480p$/i, "480p"],
];

const SOURCE: Rule[] = [
  [/^(bd)?remux$/i, "remux"],
  [/^(blu-?ray|bdrip|brrip|bd|bd50|bd25|uhd-?bluray)$/i, "bluray"],
  [/^(web-?dl|webdl|web)$/i, "web-dl"],
  [/^(web-?rip|web-?dlrip|dmrip)$/i, "webrip"],
  [/^hdtv(rip)?$/i, "hdtv"],
  [/^(\d?x?dvd(-?rip|-?[59]|scr)?)$/i, "dvd"],
  [/^(hd-?rip)$/i, "hdrip"],
  [/^dcp$/i, "dcp"],
  [/^(cam-?rip|hdcam|telesync)$/i, "cam"],
  [/^(vhs-?rip|tvrip|satrip)$/i, "tvrip"],
];

const CODEC: Rule[] = [
  [/^(x\.?265|h\.?265|hevc)$/i, "hevc"],
  [/^(x\.?264|h\.?264|avc)$/i, "avc"],
  [/^xvid$/i, "xvid"],
  [/^divx\d*$/i, "divx"],
  [/^av1$/i, "av1"],
  [/^vc-?1$/i, "vc1"],
  [/^mpeg-?2$/i, "mpeg2"],
];

const HDR: Rule[] = [
  [/^(dv|dovi)$/i, "dv"],
  [/^hdr10(\+|plus)$/i, "hdr10+"],
  [/^(hdr10|hdr)$/i, "hdr"],
  [/^sdr$/i, "sdr"],
];

const AUDIO: Rule[] = [
  [/^dts-?(hd|x|ma|es)?$/i, "dts"],
  [/^truehd$/i, "truehd"],
  [/^atmos$/i, "atmos"],
  [/^(ddp|dd\+|eac3|e-ac-3)(\d[._]\d)?$/i, "eac3"],
  [/^(dd|ac3)(\d[._]\d)?$/i, "ac3"],
  [/^aac(\d[._]\d)?$/i, "aac"],
  [/^flac(\d[._]\d)?$/i, "flac"],
  [/^(lpcm|pcm)$/i, "pcm"],
  [/^mp3$/i, "mp3"],
  [/^(\d[._]\d)$/, ""],
];

const SERVICE: Rule[] = [
  [/^nf$/i, "netflix"],
  [/^amzn$/i, "amazon"],
  [/^atvp$/i, "apple"],
  [/^it$/, "itunes"],
  [/^dsnp$/i, "disney"],
  [/^(hmax|max)$/, "max"],
  [/^hulu$/i, "hulu"],
  [/^pcok$/i, "peacock"],
];

const LANG =
  /^(rus|eng|ukr|jap|jpn|ger|fre|ita|spa|kor|chi|\d?x?rus|mvo|dvo|avo|dub|dual|multi|sub|subs|rus-eng|eng-rus)$/i;

const NOISE =
  /^(proper|repack\d?|rerip|internal|limited|hybrid|complete|10bit|8bit|hi10p|ext|open-?matte|hq|rip|mkv|full|lic|\d{2,3}fps|x?\d{3,4}x\d{3,4})$/i;

/** Tracker / translation / site words: a bracket group containing one of
 * these is noise, never an alternative title. */
const GROUP_NOISE =
  /(субтитр|дубляж|перевод|озвуч|serii|серии|серия|rutracker|torrent|club|hdclub|kinozal|lostfilm|newstudio|fps|subs?\b|rip\b|by[\s_.]|ru$)/i;

const EDITIONS: Rule[] = [
  [/director'?s[\s._-]*cut/i, "Director's Cut"],
  [/extended([\s._-]*(cut|edition|version))?/i, "Extended"],
  [/\bunrated\b/i, "Unrated"],
  [/\buncut\b/i, "Uncut"],
  [/\bremastered\b/i, "Remastered"],
  [/special[\s._-]*edition/i, "Special Edition"],
  [/\btheatrical\b/i, "Theatrical"],
  [/\bimax\b/i, "IMAX"],
  [/\bcriterion\b/i, "Criterion"],
  [/final[\s._-]*cut/i, "Final Cut"],
];

const EDITION_WORD =
  /^(director'?s|directors|extended|unrated|uncut|remastered|special|theatrical|imax|criterion|final|edition|cut|version)$/i;

function match(rules: Rule[], tok: string): string | null {
  for (const [re, v] of rules) if (re.test(tok)) return v;
  return null;
}

/** True for any word the parser treats as a tag or noise rather than title. */
export function isTagToken(tok: string): boolean {
  return techKind(tok) !== null || NOISE.test(tok) || EDITION_WORD.test(tok) ||
    /^(season|series|episode|сезон|part|disc|disk|cd|pt)$/i.test(tok);
}

/** Classify one token as a technical tag (anything that ends a title). */
function techKind(tok: string): string | null {
  if (!tok) return null;
  if (match(RESOLUTION, tok)) return "resolution";
  if (match(SOURCE, tok)) return "source";
  if (match(CODEC, tok)) return "codec";
  if (match(HDR, tok)) return "hdr";
  if (match(AUDIO, tok) !== null) return "audio";
  if (match(SERVICE, tok)) return "service";
  if (LANG.test(tok)) return "lang";
  if (/^(3d|h-?sbs|h-?ou|sbs)$/i.test(tok)) return "3d";
  return null;
}

const SERIES_RE = /\bS(\d{1,2})(?:[\s._-]?E(\d{1,3}))?\b/i;
const SEASON_WORD_RE =
  /(?<!\p{L})(?:season|series|сезон)[\s._-]*(\d{1,2})(?!\d)|(?<!\d)(\d{1,2})[\s._-]*(?:season|сезон)(?!\p{L})|(?<!\p{L})episode[\s._-]*(\d{1,3})(?!\d)/iu;
const XEP_RE = /\b(\d{1,2})x(\d{2,3})\b/i;
const PART_RE = /\b(?:cd|disc|disk|part|pt)[\s._-]*(\d{1,2})\b/i;
const CYR = /\p{Script=Cyrillic}/u;
const LAT = /\p{Script=Latin}/u;

/** Bracket/paren group content classification. */
type GroupInfo =
  | { kind: "year"; year: number }
  | { kind: "yearAlt"; year: number; alt: string }
  | { kind: "range"; year: number; yearEnd: number }
  | { kind: "alt"; alt: string }
  | { kind: "weakAlt"; alt: string }
  | { kind: "edition"; edition: string }
  | { kind: "season"; season: number }
  | { kind: "drop" };

function classifyGroup(raw: string): GroupInfo {
  const c = raw.trim();
  if (isYear(c)) return { kind: "year", year: Number(c) };
  let m = /^((?:18|19|20)\d\d)\s*[-–]\s*((?:18|19|20)\d\d)$/.exec(c);
  if (m && isYear(m[1]) && isYear(m[2])) {
    return { kind: "range", year: Number(m[1]), yearEnd: Number(m[2]) };
  }
  m = /^((?:18|19|20)\d\d)[.,:\s]+(.*\p{L}.*)$/u.exec(c);
  if (m && isYear(m[1])) {
    if (hasTech(m[2]) || GROUP_NOISE.test(m[2])) {
      return { kind: "year", year: Number(m[1]) };
    }
    return {
      kind: "yearAlt",
      year: Number(m[1]),
      alt: m[2].replace(/^[-–\s]+/, "").trim(),
    };
  }
  m = /^(.*\p{L}.*?)[,\s]+((?:18|19|20)\d\d)$/u.exec(c);
  if (m && GROUP_NOISE.test(m[1])) m = null;
  if (m && isYear(m[2]) && !hasTech(m[1])) {
    return { kind: "yearAlt", year: Number(m[2]), alt: m[1].trim() };
  }
  const sm = SEASON_WORD_RE.exec(c);
  if (sm && (sm[1] ?? sm[2])) {
    return { kind: "season", season: Number(sm[1] ?? sm[2]) };
  }
  for (const [re, v] of EDITIONS) {
    if (re.test(c) && c.replace(re, "").replace(/[\s._-]/g, "") === "") {
      return { kind: "edition", edition: v };
    }
  }
  if (hasTech(c) || GROUP_NOISE.test(c)) return { kind: "drop" };
  // Site tags / release groups / crew credits: single dense token, domains,
  // "act."/"реж." credit lists.
  if (/\.(?:[a-z]{2,4})$/i.test(c) && !/\s/.test(c)) return { kind: "drop" };
  if (/^(act|реж|dir|в ролях)[.:\s]/i.test(c)) return { kind: "drop" };
  if (!/\p{L}{2}/u.test(c)) return { kind: "drop" };
  // A single Latin word is usually a group/site tag — kept only as a weak
  // alt, which the caller uses when the main title is Cyrillic
  // ("Блэйд (Blade)") and drops otherwise ("Blade Runner (ITC)").
  if (!/\s/.test(c) && !CYR.test(c)) return { kind: "weakAlt", alt: c };
  return { kind: "alt", alt: c.replace(/^[-–\s]+|[-–\s]+$/g, "") };
}

/** True when a string contains at least one technical tag token. */
function hasTech(s: string): boolean {
  return techTokens(s).some((t) => techKind(t) !== null);
}

/** Split any string into candidate tag tokens (dots, brackets, commas,
 * underscores all separate) — used to harvest tags from the whole name,
 * including bracket groups, independent of title extraction. */
function techTokens(s: string): string[] {
  return protect(s.replace(/_/g, " "))
    .split(/[\s.\[\](),+]+/)
    .flatMap((t) =>
      techKind(t) === null && t.includes("-") ? [t, ...t.split("-")] : [t]
    )
    .filter(Boolean);
}

/** Keep dotted technical tokens intact before dots become spaces. */
function protect(s: string): string {
  return s
    .replace(/(bdrip|brrip|webrip|hdrip|dvdrip|web-dl|bdremux)(\d)/gi, "$1 $2")
    .replace(/(\p{Ll}{2})((?:19|20)\d\d)(?!\d)/gu, "$1 $2")
    .replace(/\b([hHxX])\.(26[45])\b/g, "$1$2")
    .replace(/(?<!\d)(\d)\.(\d)(?!\d)/g, "$1_$2")
    .replace(/\bWEB[.\s]DL\b/gi, "WEB-DL")
    .replace(/\bDD\+/gi, "DDP")
    .replace(/\bDolby[.\s_-]?Vision\b/gi, "DV")
    .replace(/\bHDR10\+/gi, "HDR10plus");
}

function tokenize(s: string): string[] {
  const out: string[] = [];
  for (const raw of s.split(/[\s]+/)) {
    if (!raw) continue;
    if (raw === "-" || raw === "–" || raw === "\u0000") {
      out.push(raw === "–" ? "-" : raw);
      continue;
    }
    const t = raw.replace(/^[-–]+|[-–,;:.]+$/g, "");
    if (!t) continue;
    if (t.includes(".") && techKind(t) === null) {
      const parts = t.split(".").filter(Boolean);
      if (parts.some((p) => isYear(p) || techKind(p) !== null)) {
        out.push(...tokenize(parts.join(" ")));
        continue;
      }
    }
    if (techKind(t) === null && /-/.test(t)) {
      const parts = t.split("-");
      if (parts.some((p) => techKind(p) !== null)) {
        parts.forEach((p, i) => {
          if (i > 0) out.push("-");
          if (p) out.push(p);
        });
        continue;
      }
    }
    out.push(t);
  }
  return out;
}

/** Tag kinds that may PRECEDE a title ("1080p_Forrest_Gump"); language and
 * audio tags never do, so a title like "Dub" survives. */
const LEADING_TECH = new Set(["resolution", "source", "codec", "hdr"]);

/** Cut marker left where a bracket group was removed. */
const CUT = String.fromCharCode(0);

function cleanTitle(tokens: string[]): string {
  return tokens
    .join(" ")
    .replace(/(\d)_(\d)/g, "$1.$2")
    .split(CUT).join(" ")
    .replace(/[\s.,;:]*-?[\s.,;:]*$/g, "")
    .replace(/^\s*-\s+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** A title that is very unlikely to be a real name: hex blobs, pure
 * digits, or a single 1–2 char token. */
export function isSuspectTitle(t: string): boolean {
  const s = t.trim();
  if (!s) return true;
  if (/^[0-9A-F]{6,}$/i.test(s) && /\d/.test(s)) return true;
  if (/^\d+$/.test(s) && !isYear(s) && s.length > 4) return true;
  if (s.length < 2) return true;
  return false;
}

/** Parse a file or directory name into title, year and technical tags. */
export function parseReleaseName(name: string): ReleaseInfo {
  let s = stripExt(name).normalize("NFC");
  const info: ReleaseInfo = {
    title: "",
    altTitles: [],
    year: null,
    yearEnd: null,
    edition: null,
    resolution: null,
    source: null,
    codec: null,
    hdr: [],
    audio: [],
    service: null,
    langTags: [],
    group: null,
    is3D: false,
    season: null,
    episode: null,
    isSeries: false,
    part: null,
    suspectTitle: false,
  };
  const alts: string[] = [];
  const weakAlts: string[] = [];
  let strongYear: number | null = null;

  // Release group: trailing -GROUP (only meaningful on scene-style names).
  const gm = /-([A-Za-z0-9]{2,20})(?:\[[^\]]*\])?$/.exec(s);
  if (gm && techKind(gm[1]) === null && /[._]/.test(s)) info.group = gm[1];

  // Tracker domains anywhere ("….fenixclub.com.avi", "Kinozal.TV").
  s = s.replace(
    /(^|[\s._\[(-])(?:www[._])?([\w-]+)[._](com|ru|net|org|tv|info|club|mx)(?=$|[\s._\])-])/gi,
    (m, pre: string, host: string) =>
      host.length >= 4 && techKind(host) === null && !LANG.test(host) &&
        !isYear(host)
        ? pre
        : m,
  );

  // Leading "[Group] Title" (fansub style) — a non-year bracket at the very
  // start names the releaser, not the film.
  const lg = /^\s*\[([^\]]+)\]\s*(?=\S)/.exec(s);
  if (lg && !/^\s*(?:18|19|20)\d\d\s*$/.test(lg[1])) {
    info.group ??= lg[1].trim();
    s = s.slice(lg[0].length);
  }

  // Technical tags are harvested from the WHOLE name, bracket groups
  // included ("Firestarter (1984) [BDRip] [1080p]").
  for (const t of techTokens(s)) {
    const k = techKind(t);
    if (k === "resolution") info.resolution ??= match(RESOLUTION, t);
    else if (k === "source") {
      const v = match(SOURCE, t)!;
      if (info.source === null || v === "remux") info.source = v;
    } else if (k === "codec") info.codec ??= match(CODEC, t);
    else if (k === "hdr") {
      const v = match(HDR, t)!;
      if (!info.hdr.includes(v)) info.hdr.push(v);
    } else if (k === "audio") {
      const v = match(AUDIO, t)!;
      if (v && !info.audio.includes(v)) info.audio.push(v);
    } else if (k === "service") info.service ??= match(SERVICE, t);
    else if (k === "lang") {
      for (const p of t.toLowerCase().split("-")) {
        if (!info.langTags.includes(p)) info.langTags.push(p);
      }
    } else if (k === "3d") info.is3D = true;
  }
  for (const [re, v] of EDITIONS) {
    if (re.test(s.replace(/[._]/g, " "))) {
      info.edition = v;
      break;
    }
  }

  // 1. Bracket/paren groups → year / alt title / edition / drop, leaving a
  //    cut marker (\u0000) where each group was.
  s = s.replace(/[\[(]([^\[\]()]*)[\])]/g, (_m, inner: string) => {
    const g = classifyGroup(inner);
    switch (g.kind) {
      case "year":
        strongYear ??= g.year;
        break;
      case "yearAlt":
        strongYear ??= g.year;
        alts.push(g.alt);
        break;
      case "range":
        strongYear ??= g.year;
        info.yearEnd = g.yearEnd;
        break;
      case "alt":
        alts.push(g.alt);
        break;
      case "weakAlt":
        weakAlts.push(g.alt);
        break;
      case "edition":
        info.edition ??= g.edition;
        break;
      case "season":
        info.season = g.season;
        info.isSeries = true;
        break;
    }
    return " \u0000 ";
  });

  // Unbracketed year range "1983-1999".
  s = s.replace(
    /(^|[\s._])((?:18|19|20)\d\d)\s*[-–]\s*((?:18|19|20)\d\d)(?=$|[\s._])/,
    (m, pre: string, a: string, b: string) => {
      if (!isYear(a) || !isYear(b) || Number(b) < Number(a)) return m;
      strongYear ??= Number(a);
      info.yearEnd = Number(b);
      return `${pre} \u0000 `;
    },
  );

  // 2. Separators: scene names use dots/underscores (or, rarely, only
  //    hyphens) for spaces. A dot between two words is always a separator.
  s = protect(s.replace(/_/g, " "));
  const spaces = (s.match(/ /g) ?? []).length;
  const dots = (s.match(/\./g) ?? []).length;
  if (dots > 0 && (dots >= spaces || /\S\.\S+\.\S/.test(s))) {
    s = s.replace(/\.(?=\S)|(?<=\S)\./g, " ");
  } else s = s.replace(/(?<=\p{L}{2})\.(?=\p{L}{2})/gu, " ");
  if (!/[\s.]/.test(s.trim()) && (s.match(/-/g) ?? []).length >= 2) {
    s = s.replace(/-/g, " ");
  }
  // "Годзилла-Godzilla": a hyphen joining two scripts separates titles.
  s = s
    .replace(/(\p{Script=Cyrillic})-(?=\p{Script=Latin})/gu, "$1 - ")
    .replace(/(\p{Script=Latin})-(?=\p{Script=Cyrillic})/gu, "$1 - ");

  let tokens = tokenize(s);

  // Leading "Year - Title" / "Year. Title".
  const lead = /^((?:18|19|20)\d\d)\s*[-.]\s+(\S.*)$/.exec(cleanTitle(tokens));
  if (lead && isYear(lead[1]) && strongYear === null) {
    strongYear = Number(lead[1]);
    tokens = tokenize(lead[2]);
  }

  // Series / episode markers.
  const joined = tokens.join(" ");
  const se = SERIES_RE.exec(joined);
  const xe = XEP_RE.exec(joined);
  const sw = SEASON_WORD_RE.exec(joined);
  if (se) {
    info.isSeries = true;
    info.season = Number(se[1]);
    info.episode = se[2] ? Number(se[2]) : null;
  } else if (xe && !/^\d{3,4}x\d{3,4}$/.test(xe[0])) {
    info.isSeries = true;
    info.season = Number(xe[1]);
    info.episode = Number(xe[2]);
  } else if (sw) {
    info.isSeries = true;
    if (sw[1] ?? sw[2]) info.season = Number(sw[1] ?? sw[2]);
    if (sw[3]) info.episode = Number(sw[3]);
  }
  const pm = PART_RE.exec(joined);
  if (pm) info.part = Number(pm[1]);

  // 3. Find the title cut: the first token that is a tech tag, a series
  //    marker, a group marker, an edition word, noise — or the year that
  //    precedes them.
  const seriesTok = (t: string) =>
    /^S\d{1,2}(E\d{1,3})?$/i.test(t) || /^\d{1,2}x\d{2,3}$/i.test(t) ||
    /^(?:season|series|сезон|episode)$/i.test(t);
  const isStop = (t: string, i: number): boolean =>
    t === "\u0000" ||
    techKind(t) !== null ||
    (i > 0 && /^1080$|^720$|^2160$/.test(t)) ||
    seriesTok(t) ||
    (i > 0 && EDITION_WORD.test(t) &&
      EDITIONS.some(([re]) => re.test(tokens.slice(i, i + 3).join(" ")))) ||
    (i > 0 && NOISE.test(t) && !/^\d+$/.test(t)) ||
    (i > 0 && PART_RE.test(tokens.slice(i, i + 2).join(" ")) &&
      /^(cd|disc|disk|part|pt)\d*$/i.test(t) && tokens.length > i + 2);

  // Drop leading tech tokens ("1080p_Forrest_Gump_1994") and leading
  // group markers ("[1995] Hackers").
  let start = 0;
  while (
    start < tokens.length &&
    (tokens[start] === "\u0000" || tokens[start] === "-" ||
      LEADING_TECH.has(techKind(tokens[start]) ?? "") ||
      /^1080$|^720$/.test(tokens[start]))
  ) start++;
  // "Aac.1920.1080p": if nothing but a year follows the skipped tokens,
  // the tech-looking word WAS the title.
  if (
    start > 0 &&
    (start >= tokens.length || isYear(tokens[start]) ||
      tokens[start] === CUT)
  ) start = 0;

  let cut = tokens.length;
  for (let i = start + 1; i < tokens.length; i++) {
    if (isStop(tokens[i], i)) {
      cut = i;
      break;
    }
  }

  // The last year token inside (start, cut) is the release year (keeps a
  // leading-year title like "2001 A Space Odyssey").
  let yearIdx = -1;
  for (let i = cut - 1; i > start; i--) {
    if (isYear(tokens[i])) {
      yearIdx = i;
      break;
    }
  }
  let looseYear: number | null = null;
  if (yearIdx > start) {
    looseYear = Number(tokens[yearIdx]);
    cut = yearIdx;
  } else if (strongYear === null) {
    // A year after the cut ("Title [Alt] 1984 (Rus-Eng)",
    // "No Escape BDRip 1080p.2015.D").
    for (let i = cut; i < tokens.length; i++) {
      if (isYear(tokens[i])) {
        looseYear = Number(tokens[i]);
        break;
      }
    }
  }
  info.year = strongYear ?? looseYear;

  // Text between a group cut marker and the next tech tag is an alt title
  // ("Ame Agaru-(1999)-After The Rain-DIVX").
  if (tokens[cut] === "\u0000") {
    const tail: string[] = [];
    for (let i = cut + 1; i < tokens.length; i++) {
      const t = tokens[i];
      if (
        t === "\u0000" || techKind(t) !== null || isYear(t) || seriesTok(t)
      ) break;
      if (NOISE.test(t) && tail.length === 0) continue;
      tail.push(t);
    }
    const alt = cleanTitle(tail);
    if (/\p{L}{2}/u.test(alt) && alt.split(" ").length >= 2) alts.push(alt);
  }

  let title = cleanTitle(tokens.slice(start, cut));

  // "English - Русский" (or reverse) → title + alt title.
  const dash = title.split(/\s+-\s+/);
  const pureCyr = (x: string) => CYR.test(x) && !LAT.test(x);
  if (dash.length === 2) {
    const [a, b] = dash;
    if (pureCyr(a) !== pureCyr(b)) {
      title = a.trim();
      alts.push(b.trim());
    } else title = `${a} ${b}`;
  } else if (dash.length > 2) title = dash.join(" ");

  // "Большие спорщики The Great Debaters": a Cyrillic block followed by a
  // Latin block (or the reverse) is two titles run together.
  const words = title.split(" ");
  const scriptOf = (w: string) =>
    /^[IVXLC]+$/.test(w) || /^[A-Z]{1,3}$/.test(w)
      ? "n"
      : CYR.test(w)
      ? "c"
      : LAT.test(w)
      ? "l"
      : "n";
  const seq = words.map(scriptOf).filter((x) => x !== "n").join("")
    .replace(/(.)\1+/g, "$1");
  if (seq === "cl" || seq === "lc") {
    const first = scriptOf(words.find((w) => scriptOf(w) !== "n")!);
    const k = words.findIndex((w) => {
      const sc = scriptOf(w);
      return sc !== "n" && sc !== first;
    });
    const a = cleanTitle(words.slice(0, k));
    const b = cleanTitle(words.slice(k));
    if (/\p{L}{2}/u.test(a) && /\p{L}{2}/u.test(b)) {
      title = a;
      alts.push(b);
    }
  }

  if (!title && alts.length > 0) title = alts.shift()!;
  if (CYR.test(title)) alts.push(...weakAlts);
  info.title = title;
  info.altTitles = [...new Set(alts.map((a) => cleanTitle(a.split(/\s+/))))]
    .filter((a) => a && a.toLowerCase() !== title.toLowerCase())
    .slice(0, 4);
  info.suspectTitle = isSuspectTitle(title) &&
    !(title.length === 1 && info.year !== null && /\p{L}/u.test(title));
  return info;
}
