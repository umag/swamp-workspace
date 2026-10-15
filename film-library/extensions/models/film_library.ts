// @magistr/film-library — multidimensional catalog of film shares.
//
// Inventory comes from ONE bounded listing over SSH: each configured root is
// read to `maxDepth` directory levels (default 2 — the film folders and their
// direct contents) with `stat`, skipping disc structures (BDMV/VIDEO_TS). No
// recursive `find`, no `du`: a whole pass is ~2k stat calls.
//
// Every entry is classified (film / series / episode / collection member /
// subtitle / other — software, 3D models, archives — / junk) and its name
// parsed into title, alternative titles, year and technical tags
// (resolution, source, codec, HDR, audio, edition, language tags, group).
// `scan` writes the `inventory`.
//
// Jev (TypeSafe System One, via `@webframp/typesafe-batch`) resolves names
// BEFORE any TMDB call. `names` turns each entry into 1–4 candidate readings
// (Russian title, English title, folder vs file parse, with/without year)
// and asks Jev two typed questions: what kind of thing the entry is
// (feature film / series / concert / documentary / clip / not video) and,
// per reading, whether it is the real title. Confirmed films get TMDB
// search queries; non-films and entries whose readings Jev rejected stop
// here. Unanswered entries fall back to the parser's reading.
//
// `resolve` accepts clear TMDB search hits and asks Jev to pick among the
// candidates of ambiguous searches. `catalog` joins inventory + names +
// resolution + TMDB details (tmdb `enrich`, read with readModelData — no
// runModel, so vault-backed instances work) into a star-schema cube:
//
//   facts:       one `film` resource per film (file or folder)
//   dimensions:  genres, decades, countries, languages, directors,
//                resolutions, sources, hdr, collections
//   cross-cuts:  `issues` (unmatched, non-film in film folders, library
//                duplicates, downloads already owned / to import, series in
//                the film library, non-film downloads) and a `library`
//                summary

import { z } from "npm:zod@4";
import {
  extOf,
  parseReleaseName,
  type ReleaseInfo,
  SUBTITLE_EXTS,
  VIDEO_EXTS,
} from "../lib/release.ts";
import { looksTranslit, toCyrillic } from "../lib/translit.ts";

// --- Global arguments ---

const RootSchema = z.object({
  path: z
    .string()
    .regex(/^\/[^\0\n]*$/, "must be an absolute path")
    .refine((p) => !p.split("/").includes(".."), "must not contain ..")
    .describe("Absolute directory on the host"),
  role: z
    .enum(["library", "incoming"])
    .describe(
      "library = curated film collection; incoming = download landing zone",
    ),
});

const GlobalArgsSchema = z.object({
  host: z.string().min(1).describe("Host with the film shares (unraid)"),
  sshUser: z.string().default("root").describe("SSH user"),
  roots: z
    .array(RootSchema)
    .min(1)
    .default([
      { path: "/mnt/user/films/cinema", role: "library" },
      { path: "/mnt/user/downloads/complete", role: "incoming" },
    ])
    .describe("Directories to catalog"),
  maxDepth: z
    .number()
    .int()
    .min(1)
    .max(3)
    .default(2)
    .describe(
      "Directory levels listed under each root (2 = film folders and their direct contents; 3 also lists season/CD subfolders)",
    ),
  tmdbInstance: z
    .string()
    .default("tmdb")
    .describe("@magistr/tmdb instance whose match set catalog reads"),
  setName: z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]{0,40}$/)
    .default("films")
    .describe(
      "Shared name tying the pipeline together: the tmdb match and titles resources are named this, and Jev batches are named <setName>-pairs-N / <setName>-kinds-N",
    ),
  jevInstance: z
    .string()
    .default("jev")
    .describe(
      "@swamp/typesafe-ai instance with @webframp/typesafe-batch answers (optional)",
    ),
  overrides: z
    .record(
      z.string(),
      z.union([
        z.number().int().positive(),
        z.string().regex(/^(movie|tv):[1-9]\d*$/),
      ]),
    )
    .default({})
    .describe(
      'Pin an absolute host path to a TMDB id when the automatic match is wrong: a movie id, or "tv:<id>" / "movie:<id>"',
    ),
  kinds: z
    .record(z.string(), z.string())
    .default({})
    .describe(
      "Pin an absolute host path to a kind (tv_series, stage_or_concert, short_or_clip, not_video, ...): the entry is catalogued with that kind and never searched on TMDB",
    ),
  ignore: z
    .array(z.string())
    .default([])
    .describe("Absolute host paths to leave out of the catalog"),
});

type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

// --- SSH ---

function shQuote(s: string): string {
  return "'" + String(s).replaceAll("'", `'\\''`) + "'";
}

/** Host-side import: $1 = target dir, rest = sources. One line per source:
 * RESULT\tsource\tdestination. mv -n never overwrites. */
export const IMPORT_SCRIPT = `set -u
t="$1"; shift
for s in "$@"; do
  d="$t/\${s##*/}"
  if [ -e "$s" ] && [ -e "$d" ]; then r=CONFLICT
  elif [ -e "$s" ]; then
    if mv -n -- "$s" "$t/" 2>/dev/null && [ ! -e "$s" ] && [ -e "$d" ]; then r=MOVED; else r=MV_FAILED; fi
  elif [ -e "$d" ]; then r=ALREADY
  else r=MISSING; fi
  printf "%s\\t%s\\t%s\\n" "$r" "$s" "$d"
done
`;

/** Host-side delete: args are (download, library copy) pairs. One line per
 * download: RESULT\tpath\tbytes. Deletes only when the library copy exists. */
export const REMOVE_SCRIPT = `set -u
while [ $# -ge 2 ]; do
  s="$1"; k="$2"; shift 2
  if [ ! -e "$s" ]; then r=MISSING; b=0
  elif [ ! -e "$k" ]; then r=NO_LIBRARY_COPY; b=0
  else b=$(du -sb -- "$s" | cut -f1); if rm -rf -- "$s" && [ ! -e "$s" ]; then r=DELETED; else r=RM_FAILED; fi; fi
  printf "%s\\t%s\\t%s\\n" "$r" "$s" "$b"
done
`;

/** Resource schema for a `remove` run: one outcome per download path considered. */
export const RemovalsSchema = z.object({
  outcomes: z.array(
    z.object({ result: z.string(), path: z.string(), bytes: z.number() }),
  ),
  deleted: z.number(),
  freedBytes: z.number(),
  removedAt: z.string(),
});

/** Resource schema for an `import` run: one outcome per file moved into the library. */
export const ImportsSchema = z.object({
  target: z.string(),
  outcomes: z.array(
    z.object({ result: z.string(), path: z.string(), dest: z.string() }),
  ),
  moved: z.number(),
  failed: z.number(),
  importedAt: z.string(),
});

async function sshRun(
  host: string,
  sshUser: string,
  command: string,
  stdinText?: string,
  timeoutMs = 300000,
): Promise<string> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
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
    clearTimeout(timer);
  }
}

/** Remote listing script: bounded-depth readdir + one `stat` per directory
 * (all its children in one call). Records are US (\x1f) separated fields,
 * RS (\x1e) terminated, so any file name without control chars survives. */
export const LIST_SCRIPT = `set -u
shopt -s nullglob
MAX="$1"; shift
walk() {
  local d="$1" depth="$2" k base
  local kids=("$d"/*)
  [ \${#kids[@]} -eq 0 ] && return 0
  stat --printf='E\\037%F\\037%s\\037%Y\\037%n\\036' -- "\${kids[@]}" 2>/dev/null
  [ "$depth" -ge "$MAX" ] && return 0
  for k in "\${kids[@]}"; do
    [ -d "$k" ] && [ ! -L "$k" ] || continue
    base="\${k##*/}"
    case "$base" in BDMV|VIDEO_TS|AUDIO_TS|CERTIFICATE|AACS|BACKUP|@eaDir) continue;; esac
    walk "$k" $((depth+1))
  done
}
for root in "$@"; do
  if [ -d "$root" ]; then printf 'R\\037%s\\036' "$root"; walk "$root" 1
  else printf 'M\\037%s\\036' "$root"; fi
done
`;

/** One filesystem entry found under a library or incoming root. */
export type ListedEntry = {
  root: string;
  path: string;
  rel: string;
  name: string;
  depth: number;
  isDir: boolean;
  size: number;
  mtime: number;
};

/** Parse LIST_SCRIPT output into entries grouped under their root.
 * Throws on a structurally broken record (wrong field count). */
export function parseListing(raw: string): {
  entries: ListedEntry[];
  missingRoots: string[];
  roots: string[];
} {
  const entries: ListedEntry[] = [];
  const missingRoots: string[] = [];
  const roots: string[] = [];
  let root: string | null = null;
  for (const rec of raw.split("\x1e")) {
    if (!rec.trim()) continue;
    const f = rec.replace(/^\n+/, "").split("\x1f");
    if (f[0] === "R" && f.length === 2) {
      root = f[1].replace(/\/+$/, "");
      roots.push(root);
      continue;
    }
    if (f[0] === "M" && f.length === 2) {
      missingRoots.push(f[1]);
      continue;
    }
    if (f[0] !== "E" || f.length !== 5) {
      throw new Error(`malformed listing record: ${JSON.stringify(rec)}`);
    }
    const [, type, size, mtime, path] = f;
    if (root === null || !path.startsWith(root + "/")) continue;
    const rel = path.slice(root.length + 1);
    entries.push({
      root,
      path,
      rel,
      name: rel.split("/").pop()!,
      depth: rel.split("/").length,
      isDir: type === "directory",
      size: Number(size) || 0,
      mtime: Number(mtime) || 0,
    });
  }
  return { entries, missingRoots, roots };
}

// --- Classification ---

const SOFTWARE_EXTS = new Set(["dmg", "exe", "pkg", "msi", "app", "apk"]);
const ARCHIVE_EXTS = new Set(["zip", "rar", "7z", "tar", "gz", "tgz", "bz2"]);
const MODEL3D_EXTS = new Set(["stl", "obj", "3mf", "lys", "blend", "chitubox"]);
const AUDIO_EXTS = new Set(["flac", "mp3", "ogg", "opus", "m4a", "wav", "ape"]);
const IMAGE_EXTS = new Set(["jpg", "jpeg", "png", "gif", "webp", "bmp"]);
const BOOK_EXTS = new Set(["fb2", "epub", "pdf", "djvu", "mobi"]);
const EXTRAS_DIR =
  /^(sample|samples|extras?|featurettes?|bonus|behind the scenes|deleted scenes|trailers?|subs?|subtitles?)$/i;
const SAMPLE_MAX_BYTES = 300 * 1024 * 1024;
const JUNK_MAX_BYTES = 50 * 1024 * 1024;

/** Coarse classification of a scanned entry (video kinds plus non-video buckets). */
export type ItemClass =
  | "film"
  | "series"
  | "episode"
  | "subtitle"
  | "other"
  | "junk"
  | "unknown";

/** Sub-kind for a non-video entry, or null when it is video or unknown. */
export type OtherKind =
  | "software"
  | "archive"
  | "model3d"
  | "audio"
  | "image"
  | "book"
  | "misc"
  | null;

/** A classified library or incoming entry, the unit every later stage works on. */
export type Item = {
  key: string;
  role: "library" | "incoming";
  root: string;
  path: string;
  rel: string;
  entryType: "file" | "dir";
  class: ItemClass;
  otherKind: OtherKind;
  collection: string | null;
  title: string;
  altTitles: string[];
  year: number | null;
  edition: string | null;
  resolution: string | null;
  source: string | null;
  codec: string | null;
  hdr: string[];
  audio: string[];
  langTags: string[];
  group: string | null;
  is3D: boolean;
  season: number | null;
  episode: number | null;
  disc: "bluray" | "dvd" | null;
  container: string | null;
  mainFile: string | null;
  videoFiles: number;
  subtitleFiles: number;
  sizeBytes: number;
  sizeComplete: boolean;
  mtime: number;
  suspectTitle: boolean;
};

/** 8-hex FNV-1a hash. */
export function hash8(s: string): string {
  let h = 0x811c9dc5;
  for (const ch of new TextEncoder().encode(s)) {
    h ^= ch;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/** ASCII slug for resource names (non-ASCII folds away; the hash keeps
 * names unique). */
export function slugify(s: string, max = 40): string {
  return s
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, max) || "x";
}

/** Stable item key: `film-<slug>-<hash8(path)>`. */
export function itemKey(path: string, title: string): string {
  return `film-${slugify(title || path.split("/").pop()!)}-${hash8(path)}`;
}

function otherKindOf(exts: string[]): OtherKind {
  const count = (set: Set<string>) => exts.filter((e) => set.has(e)).length;
  const ranked: [OtherKind, number][] = [
    ["software", count(SOFTWARE_EXTS)],
    ["model3d", count(MODEL3D_EXTS)],
    ["archive", count(ARCHIVE_EXTS)],
    ["audio", count(AUDIO_EXTS)],
    ["book", count(BOOK_EXTS)],
    ["image", count(IMAGE_EXTS)],
  ];
  ranked.sort((a, b) => b[1] - a[1]);
  return ranked[0][1] > 0 ? ranked[0][0] : "misc";
}

const isVideo = (name: string) => VIDEO_EXTS.has(extOf(name));
const isSample = (e: ListedEntry) =>
  /(^|[\s._-])sample([\s._-]|$)/i.test(e.name) && e.size < SAMPLE_MAX_BYTES;

/** Merge a folder's parse with its main file's parse: the folder names the
 * film; the file fills gaps (and replaces a generic or suspect folder
 * title). Tags are unioned, the file's values filling empty slots. */
export function mergeParses(dir: ReleaseInfo, file: ReleaseInfo | null) {
  if (!file) return dir;
  const generic = !dir.title || dir.suspectTitle ||
    /^(movie|film|video|bdmv|new folder)$/i.test(dir.title);
  const base = generic ? file : dir;
  const other = generic ? dir : file;
  return {
    ...base,
    altTitles: [...new Set([...base.altTitles, ...other.altTitles])].slice(
      0,
      4,
    ),
    year: base.year ?? other.year,
    edition: base.edition ?? other.edition,
    resolution: base.resolution ?? other.resolution,
    source: base.source ?? other.source,
    codec: base.codec ?? other.codec,
    hdr: [...new Set([...base.hdr, ...other.hdr])],
    audio: [...new Set([...base.audio, ...other.audio])],
    langTags: [...new Set([...base.langTags, ...other.langTags])],
    group: base.group ?? other.group,
    is3D: base.is3D || other.is3D,
    isSeries: dir.isSeries || file.isSeries,
    season: base.season ?? other.season,
    episode: base.episode ?? other.episode,
  };
}

function makeItem(
  role: Item["role"],
  root: string,
  e: ListedEntry,
  cls: ItemClass,
  p: ReleaseInfo,
  extra: Partial<Item>,
): Item {
  return {
    key: itemKey(e.path, p.title),
    role,
    root,
    path: e.path,
    rel: e.rel,
    entryType: e.isDir ? "dir" : "file",
    class: cls,
    otherKind: null,
    collection: null,
    title: p.title,
    altTitles: p.altTitles,
    year: p.year,
    edition: p.edition,
    resolution: p.resolution,
    source: p.source,
    codec: p.codec,
    hdr: p.hdr,
    audio: p.audio,
    langTags: p.langTags,
    group: p.group,
    is3D: p.is3D,
    season: p.season,
    episode: p.episode,
    disc: null,
    container: e.isDir ? null : extOf(e.name) || null,
    mainFile: e.isDir ? null : e.path,
    videoFiles: e.isDir ? 0 : isVideo(e.name) ? 1 : 0,
    subtitleFiles: 0,
    sizeBytes: e.size,
    sizeComplete: !e.isDir,
    mtime: e.mtime,
    suspectTitle: p.suspectTitle,
    ...extra,
  };
}

/** Classify every top-level entry of one root into catalog items. A folder
 * of several unrelated films becomes one item per film (collection
 * members); a folder of episodes is one series item. */
export function classifyRoot(
  root: string,
  role: Item["role"],
  entries: ListedEntry[],
  maxDepth: number,
): Item[] {
  const children = new Map<string, ListedEntry[]>();
  for (const e of entries) {
    if (e.depth < 2) continue;
    const top = e.rel.split("/")[0];
    if (!children.has(top)) children.set(top, []);
    children.get(top)!.push(e);
  }
  const items: Item[] = [];
  for (const e of entries.filter((x) => x.depth === 1)) {
    const p = parseReleaseName(e.name);
    if (!e.isDir) {
      const ext = extOf(e.name);
      if (VIDEO_EXTS.has(ext)) {
        if (e.size < JUNK_MAX_BYTES && ext !== "iso") {
          items.push(makeItem(role, root, e, "junk", p, {}));
        } else {
          items.push(
            makeItem(role, root, e, p.isSeries ? "episode" : "film", p, {}),
          );
        }
      } else if (SUBTITLE_EXTS.has(ext)) {
        items.push(makeItem(role, root, e, "subtitle", p, {}));
      } else if (ext === "nfo" || ext === "txt" || ext === "torrent") {
        items.push(makeItem(role, root, e, "junk", p, {}));
      } else {
        items.push(
          makeItem(role, root, e, "other", p, {
            otherKind: otherKindOf([ext]),
          }),
        );
      }
      continue;
    }

    // Directory.
    const kids = children.get(e.name) ?? [];
    const direct = kids.filter((k) => k.depth === 2);
    const listedDirs = new Set(
      kids.filter((k) => k.depth > 2).map((k) =>
        k.rel.split("/").slice(0, 2).join("/")
      ),
    );
    const unexpanded = direct.filter((k) =>
      k.isDir && !listedDirs.has(k.rel) && !EXTRAS_DIR.test(k.name)
    );
    const disc = direct.some((k) => k.isDir && k.name === "BDMV")
      ? "bluray"
      : direct.some((k) => k.isDir && k.name === "VIDEO_TS")
      ? "dvd"
      : null;
    const files = kids.filter((k) => !k.isDir);
    const sizeBytes = files.reduce((a, k) => a + k.size, 0);
    const sizeComplete = !disc &&
      direct.filter((k) => k.isDir).every((k) =>
        listedDirs.has(k.rel) || maxDepth > 2
      ) && unexpanded.length === 0;
    const inExtras = (k: ListedEntry) =>
      k.rel.split("/").slice(1, -1).some((seg) => EXTRAS_DIR.test(seg));
    const videos = files
      .filter((k) => isVideo(k.name) && !isSample(k) && !inExtras(k))
      .sort((a, b) => b.size - a.size);
    const subs = files.filter((k) => SUBTITLE_EXTS.has(extOf(k.name)));
    const mtime = Math.max(e.mtime, ...files.map((k) => k.mtime));
    const common = {
      sizeBytes,
      sizeComplete,
      mtime,
      subtitleFiles: subs.length,
      videoFiles: videos.length,
      disc,
    } as Partial<Item>;

    const episodeLike = videos.filter((v) => parseReleaseName(v.name).isSeries);
    const seasonDirs = direct.filter((k) =>
      k.isDir && /^(season|сезон|s)\s*\d{1,2}$/i.test(k.name.trim())
    );
    if (
      p.isSeries || episodeLike.length >= 2 || seasonDirs.length > 0
    ) {
      items.push(makeItem(role, root, e, "series", p, common));
      continue;
    }

    if (disc) {
      items.push(
        makeItem(role, root, e, "film", p, { ...common, container: disc }),
      );
      continue;
    }

    if (videos.length === 0) {
      const exts = files.map((k) => extOf(k.name)).filter(Boolean);
      if (exts.length === 0 && unexpanded.length > 0) {
        items.push(makeItem(role, root, e, "unknown", p, common));
      } else {
        items.push(
          makeItem(role, root, e, "other", p, {
            ...common,
            otherKind: otherKindOf(exts),
          }),
        );
      }
      continue;
    }

    const main = videos[0];
    // Collection: several feature-size videos whose parsed titles differ
    // and that are not numbered parts of one film. Inside a collection a
    // leading "1." / "02 " is an index, not part of the title.
    const big = videos.filter((v) => v.size >= main.size * 0.3);
    const parsedBig = big.map((v) => {
      const vp = parseReleaseName(v.name);
      const t = vp.title.replace(/^\d{1,2}[.\s_-]+(?=\p{L})/u, "").trim();
      return { v, p: { ...vp, title: t || vp.title } };
    });
    const norm = (t: string) => t.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
    const distinctTitles = new Set(parsedBig.map((x) => norm(x.p.title)));
    // Two videos named "X1"/"X2" ("01.X"/"02.X") with no differing years
    // are the two halves of one film.
    const bases = new Set(
      parsedBig.map((x) => norm(x.p.title.replace(/[\s._-]*\d{1,2}$/, ""))),
    );
    const years = new Set(parsedBig.map((x) => x.p.year).filter((y) => y));
    const partsOfOne = parsedBig.every((x) => x.p.part !== null) ||
      (big.length === 2 && bases.size === 1 && years.size <= 1);
    if (big.length >= 2 && !partsOfOne && distinctTitles.size >= 2) {
      for (const { v, p: vp } of parsedBig) {
        const merged = mergeParses(vp, null);
        items.push(
          makeItem(role, root, v, "film", merged, {
            collection: e.name,
            videoFiles: 1,
            subtitleFiles: 0,
          }),
        );
      }
      continue;
    }

    const merged = mergeParses(p, parseReleaseName(main.name));
    if (partsOfOne && big.length >= 2) {
      merged.title = merged.title.replace(/[\s._-]*\d{1,2}$/, "") ||
        merged.title;
    }
    items.push(
      makeItem(role, root, e, "film", merged as ReleaseInfo, {
        ...common,
        container: extOf(main.name) || null,
        mainFile: main.path,
      }),
    );
  }
  return items;
}

// --- Name resolution: Jev picks the reading, before any TMDB call (pure) ---

/** One candidate reading of an entry name: an id, a title and an optional year. */
export type Reading = { id: string; title: string; year: number | null };

/** Candidate readings of an entry's name, for Jev to confirm: the parse of
 * the entry name and (for folders) of its main file, each with its
 * alternative titles, deduplicated, at most `max`. When every parse is
 * suspect, the bare stripped name is offered so Jev can still judge it. */
export function buildReadings(it: Item, max = 4): Reading[] {
  const base = it.path.split("/").pop()!;
  const parses = [parseReleaseName(base)];
  if (it.mainFile && it.mainFile !== it.path) {
    parses.push(parseReleaseName(it.mainFile.split("/").pop()!));
  }
  const raw: { title: string; year: number | null }[] = [];
  if (it.title && !it.suspectTitle) {
    raw.push({ title: it.title, year: it.year });
  }
  for (const p of parses) {
    if (p.title && !p.suspectTitle) raw.push({ title: p.title, year: p.year });
    for (const a of p.altTitles) raw.push({ title: a, year: p.year });
  }
  for (const a of it.altTitles) raw.push({ title: a, year: it.year });
  if (raw.length === 0) {
    const bare = base.replace(/\.[a-z0-9]{2,4}$/i, "").replace(/[._]+/g, " ")
      .trim();
    if (bare) raw.push({ title: bare, year: it.year });
  }
  // Romanised Russian ("Gadkiy ya 2") gets a Cyrillic reading so Jev can
  // recognise it and TMDB's search can find it; it goes second so the
  // reading cap never drops it.
  const translit = raw
    .filter((r) => looksTranslit(r.title))
    .map((r) => ({ title: toCyrillic(r.title), year: r.year }));
  if (translit.length) raw.splice(1, 0, ...translit);
  const seen = new Set<string>();
  const out: Reading[] = [];
  for (const r of raw) {
    const t = r.title.replace(/\s+/g, " ").trim();
    const norm = `${t.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "")}|${
      r.year ?? ""
    }`;
    if (!t || seen.has(norm)) continue;
    seen.add(norm);
    out.push({ id: hash8(`${t}|${r.year ?? ""}`), title: t, year: r.year });
    if (out.length >= max) break;
  }
  return out;
}

/** Jev review answers, keyed for the name, kind and TMDB-pair questions. */
export type JevAnswers = {
  /** `${itemKey}::${tmdbId}` → P(the TMDB candidate is this file's film). */
  pairs: Map<string, number>;
  /** itemKey → {kind, confidence}. */
  kinds: Map<string, { kind: string; confidence: number }>;
  /** `${itemKey}::n::${readingId}` → P(the reading is this file's title). */
  names: Map<string, number>;
};

/** Jev question confirming one reading of a file name. */
export const JEV_NAME_QUESTIONS = {
  correct_title: {
    type: "noul",
    instructions:
      "The state has a file or folder name from a home film collection and ONE proposed reading of it (a title and, if known, a release year). Names may mix Russian and English, use transliteration, dots or underscores, release tags, or be a folder holding several films. Is the proposed title (in any language it appears) the actual title of the film in this file, and is the year right or absent?",
  },
};

/** Jev question classifying what an entry contains. */
export const JEV_KIND_QUESTIONS = {
  kind: {
    type: "choice",
    instructions:
      "The state is a file or folder name found in a home film/download folder, with its size and file counts. What does it most likely contain?",
    criteria: {
      feature_film: "A feature film or animated movie",
      tv_series: "Episodes or seasons of a TV series",
      stage_or_concert:
        "A recorded concert, opera, ballet, theatre or stand-up show",
      documentary: "A documentary film",
      short_or_clip: "A short film, music video, demo or clip",
      not_video: "Software, books, 3D models, music or other non-video data",
    },
  },
};

/** Jev question for an ambiguous TMDB search: one noul per candidate. */
export const JEV_PAIR_QUESTIONS = {
  same_film: {
    type: "noul",
    instructions:
      "The state has a file or folder name from a home film collection, the title and year already confirmed for it, and ONE candidate from The Movie Database. Is the candidate the film this file contains?",
  },
};

/** Kinds that are films for the catalog (TMDB can match them). Concerts,
 * stage recordings and shorts stay searchable — TMDB lists many — and
 * are only tagged; a confident tv_series / not_video ends the entry. */
export const FILM_KINDS = new Set([
  "feature_film",
  "documentary",
  "stage_or_concert",
  "short_or_clip",
]);

/** The settled name and kind for one entry after Jev review. */
export type NameDecision = {
  key: string;
  kind: string | null;
  kindConfidence: number | null;
  status:
    | "confirmed"
    | "uncertain"
    | "parser"
    | "rejected"
    | "not-film"
    | "pinned";
  title: string | null;
  altTitles: string[];
  year: number | null;
  readings: (Reading & { p: number | null })[];
};

/** A manual TMDB override: a bare movie id or a `movie:`/`tv:` prefixed id. */
export type Pin = number | string;

/** A pin value as {kind, id}: a bare number is a movie id. */
export function parsePin(
  pin: Pin | undefined,
): { kind: "movie" | "tv"; id: number } | null {
  if (pin === undefined) return null;
  if (typeof pin === "number") return { kind: "movie", id: pin };
  const m = /^(movie|tv):([1-9]\d*)$/.exec(pin);
  return m ? { kind: m[1] as "movie" | "tv", id: Number(m[2]) } : null;
}

/** The confirmed title, alternate titles and year used to search TMDB for one entry. */
export type MatchQuery = {
  key: string;
  title: string;
  altTitles: string[];
  year: number | null;
  kind: "movie" | "tv";
  tmdbId?: number;
};

const VIDEOISH = new Set(["film", "episode", "series", "unknown"]);

/** Name statuses that go on to a TMDB search. */
export const SEARCHED = new Set(["confirmed", "uncertain", "parser", "pinned"]);

/** Decide each entry's name and kind from Jev's answers.
 *
 * - kind: Jev's choice when its confidence ≥ kindThreshold; a confident
 *   non-film kind ends the entry here (no TMDB search). Without an answer
 *   the folder heuristic stands (film class → film).
 * - name: every reading with P ≥ nameThreshold is confirmed; the most
 *   likely becomes the title, the rest alt titles (a Russian and an English
 *   title are both right). Jev scores correct-but-unfamiliar titles (new
 *   releases, obscure films) around 0.4–0.6, so a best reading between
 *   rejectBelow and nameThreshold is `uncertain` and still searched — the
 *   TMDB hit is then checked. Only when every reading is below rejectBelow
 *   is the entry `rejected` and not searched. Unanswered → the parser's
 *   reading (`parser`), so a capped run still makes progress.
 * - an `overrides` pin skips all of it. A `kinds` pin (manual review) sets the
 *   kind and skips the TMDB search. */
export function decideNames(
  items: Item[],
  jev: JevAnswers,
  overrides: Record<string, Pin>,
  opts: {
    nameThreshold: number;
    rejectBelow: number;
    kindThreshold: number;
    kinds?: Record<string, string>;
  },
): NameDecision[] {
  const out: NameDecision[] = [];
  for (const it of items) {
    if (!VIDEOISH.has(it.class)) continue;
    const k = jev.kinds.get(it.key) ?? null;
    const confidentKind = k && k.confidence >= opts.kindThreshold
      ? k.kind
      : null;
    const isFilm = confidentKind
      ? FILM_KINDS.has(confidentKind)
      : it.class === "film";
    const readings = buildReadings(it).map((r) => ({
      ...r,
      p: jev.names.get(`${it.key}::n::${r.id}`) ?? null,
    }));
    const base = {
      key: it.key,
      kind: k?.kind ?? null,
      kindConfidence: k?.confidence ?? null,
      readings,
    };
    if (overrides[it.path]) {
      out.push({
        ...base,
        status: "pinned",
        title: readings[0]?.title ?? it.title,
        altTitles: [],
        year: it.year,
      });
      continue;
    }
    const pinnedKind = opts.kinds?.[it.path];
    if (pinnedKind) {
      out.push({
        ...base,
        kind: pinnedKind,
        kindConfidence: 1,
        status: "not-film",
        title: null,
        altTitles: [],
        year: null,
      });
      continue;
    }
    if (!isFilm) {
      out.push({
        ...base,
        status: "not-film",
        title: null,
        altTitles: [],
        year: null,
      });
      continue;
    }
    const answered = readings.filter((r) => r.p !== null);
    if (answered.length > 0) {
      const ranked = [...answered].sort((a, b) => b.p! - a.p!);
      let ok = ranked.filter((r) => r.p! >= opts.nameThreshold);
      let status: NameDecision["status"] = "confirmed";
      if (ok.length === 0) {
        ok = ranked.filter((r) => r.p! >= opts.rejectBelow);
        status = "uncertain";
      }
      if (ok.length === 0) {
        out.push({
          ...base,
          status: "rejected",
          title: null,
          altTitles: [],
          year: null,
        });
        continue;
      }
      out.push({
        ...base,
        status,
        title: ok[0].title,
        altTitles: ok.slice(1).map((r) => r.title).filter((t) =>
          t !== ok[0].title
        ),
        year: ok[0].year ?? ok.find((r) => r.year !== null)?.year ?? null,
      });
      continue;
    }
    const first = readings[0] ?? null;
    out.push({
      ...base,
      status: first ? "parser" : "rejected",
      title: first?.title ?? null,
      altTitles: readings.slice(1).map((r) => r.title),
      year: first?.year ?? null,
    });
  }
  return out;
}

/** TMDB match items from name decisions (films only; pins carry tmdbId). */
export function buildMatchQueries(
  items: Item[],
  names: NameDecision[],
  overrides: Record<string, Pin>,
): MatchQuery[] {
  const byKey = new Map(items.map((i) => [i.key, i]));
  const out: MatchQuery[] = [];
  for (const n of names) {
    const it = byKey.get(n.key);
    if (!it || !n.title) continue;
    if (!SEARCHED.has(n.status)) continue;
    const pin = parsePin(overrides[it.path]);
    out.push({
      key: n.key,
      title: n.title,
      altTitles: n.altTitles.slice(0, 4),
      year: n.year,
      kind: pin?.kind ?? "movie",
      ...(pin ? { tmdbId: pin.id } : {}),
    });
  }
  return out;
}

/** One open review question sent to Jev, with its id and state payload. */
export type ReviewItem = { id: string; state: Record<string, unknown> };

/** Open Jev questions about names and kinds: a kind choice per video entry
 * and a correct_title noul per (entry × reading), skipping answered ones
 * unless `refresh`. */
export function buildNameReview(
  items: Item[],
  jev: JevAnswers,
  opts: { batchSize: number; refresh: boolean; maxBatches: number },
) {
  const kinds: ReviewItem[] = [];
  const names: ReviewItem[] = [];
  for (const it of items) {
    if (!VIDEOISH.has(it.class)) continue;
    const name = it.path.split("/").pop()!;
    if (opts.refresh || !jev.kinds.has(it.key)) {
      kinds.push({
        id: it.key,
        state: {
          name,
          folder: it.collection,
          sizeGB: Math.round(it.sizeBytes / 1e8) / 10,
          videoFiles: it.videoFiles,
          entryType: it.entryType,
        },
      });
    }
    for (const r of buildReadings(it)) {
      const id = `${it.key}::n::${r.id}`;
      if (!opts.refresh && jev.names.has(id)) continue;
      names.push({
        id,
        state: {
          fileName: name,
          folder: it.collection,
          mainFile: it.mainFile && it.mainFile !== it.path
            ? it.mainFile.split("/").pop()
            : null,
          proposedTitle: r.title,
          proposedYear: r.year,
        },
      });
    }
  }
  const cap = (b: ReviewItem[][]) =>
    opts.maxBatches > 0 ? b.slice(0, opts.maxBatches) : b;
  return {
    kindBatches: cap(chunk(kinds, opts.batchSize)),
    nameBatches: cap(chunk(names, opts.batchSize)),
    pendingKinds: kinds.length,
    pendingNames: names.length,
  };
}

// --- TMDB resolution: TMDB searches the confirmed name, Jev settles ties ---

/** One TMDB search result considered as a match for an entry. */
export type Candidate = {
  id: number;
  kind: "movie" | "tv";
  title: string;
  originalTitle: string | null;
  year: number | null;
  overview: string | null;
  score?: number;
  voteCount?: number;
};

/** The TMDB match outcome for one entry, with its best candidates. */
export type MatchEntry = {
  key: string;
  status: "matched" | "pinned" | "ambiguous" | "unmatched" | "error";
  score: number | null;
  tmdbId: number | null;
  candidates: Candidate[];
  error: string | null;
};

/** The final TMDB identity chosen for an entry, and how it was reached. */
export type Decision = {
  key: string;
  tmdbId: number | null;
  tmdbKind: "movie" | "tv";
  via: "pinned" | "score" | "jev" | "none";
  confidence: number | null;
  jevVerdict: "accepted" | "rejected-all" | "undecided" | "unasked";
  candidates: {
    id: number;
    title: string;
    year: number | null;
    p: number | null;
    score: number | null;
  }[];
};

/** Decide each searched item's TMDB id. The name is already Jev-confirmed,
 * so a clear string-score match is accepted as is. An ambiguous search (or
 * an unmatched one that still returned candidates — typically a translated
 * title) goes to Jev: the top candidate is accepted when P ≥ threshold and
 * leads the next by ≥ margin; Jev rejecting all leaves it unmatched. */
/** True when a string-score hit can be accepted without asking Jev: the
 * name carries a year and the hit's year is within one of it. A yearless
 * name (remakes!) or a year mismatch goes to Jev like an ambiguous search. */
export function scoreHitTrusted(
  m: MatchEntry,
  name: NameDecision | undefined,
): boolean {
  if (m.status !== "matched" || m.tmdbId === null) return false;
  const hit = m.candidates.find((c) => c.id === m.tmdbId);
  const want = name?.year ?? null;
  return want !== null && hit?.year != null && Math.abs(hit.year - want) <= 1;
}

/** Combine TMDB matches, name decisions, Jev answers and pins into one final decision per entry. */
export function decide(
  matches: Map<string, MatchEntry>,
  names: Map<string, NameDecision>,
  jev: JevAnswers,
  opts: { threshold: number; margin: number },
): Decision[] {
  const out: Decision[] = [];
  for (const m of matches.values()) {
    const cands = m.candidates.slice(0, 3).map((c) => ({
      id: c.id,
      title: c.title,
      year: c.year,
      p: jev.pairs.get(`${m.key}::${c.id}`) ?? null,
      score: c.score ?? null,
    }));
    const base = {
      key: m.key,
      tmdbKind: (m.candidates[0]?.kind ?? "movie") as "movie" | "tv",
      candidates: cands,
    };
    const trusted = m.status === "pinned"
      ? m.tmdbId !== null
      : scoreHitTrusted(m, names.get(m.key));
    if (trusted) {
      out.push({
        ...base,
        tmdbId: m.tmdbId,
        via: m.status === "pinned" ? "pinned" : "score",
        confidence: m.status === "pinned" ? 1 : m.score,
        jevVerdict: "unasked",
      });
      continue;
    }
    const asked = cands.filter((c) => c.p !== null).sort((a, b) => b.p! - a.p!);
    if (asked.length === 0) {
      // Not asked yet (batch cap, Jev outage): keep a string-score hit
      // provisionally so the catalog does not lose it; Jev overrides later.
      const provisional = m.status === "matched" && m.tmdbId !== null;
      out.push({
        ...base,
        tmdbId: provisional ? m.tmdbId : null,
        via: provisional ? "score" : "none",
        confidence: m.score,
        jevVerdict: "unasked",
      });
      continue;
    }
    let [top, second] = asked;
    // TMDB often lists one film twice (a re-release, a short with the
    // same name). When Jev accepts both and they share title and year,
    // the far more-voted entry is the film; the other no longer competes.
    if (second && second.p! >= opts.threshold) {
      const full = (id: number) => m.candidates.find((c) => c.id === id);
      const a = full(top.id);
      const b = full(second.id);
      const same = a && b && a.year === b.year &&
        a.title.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "") ===
          b.title.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
      if (same) {
        const va = a.voteCount ?? 0;
        const vb = b.voteCount ?? 0;
        if (vb > va * 5) top = second;
        if (Math.max(va, vb) > Math.min(va, vb) * 5) second = asked[2];
      }
    }
    if (top.p! >= opts.threshold && top.p! - (second?.p ?? 0) >= opts.margin) {
      out.push({
        ...base,
        tmdbKind: m.candidates.find((c) => c.id === top.id)?.kind ?? "movie",
        tmdbId: top.id,
        via: "jev",
        confidence: top.p,
        jevVerdict: "accepted",
      });
    } else {
      out.push({
        ...base,
        tmdbId: null,
        via: "none",
        confidence: top.p,
        jevVerdict: top.p! < 1 - opts.threshold ? "rejected-all" : "undecided",
      });
    }
  }
  return out;
}

/** Open Jev pair questions: top-3 candidates of every ambiguous search and
 * every unmatched search that returned candidates. */
export function buildPairReview(
  items: Item[],
  names: Map<string, NameDecision>,
  matches: Map<string, MatchEntry>,
  jev: JevAnswers,
  opts: { batchSize: number; refresh: boolean; maxBatches: number },
) {
  const byKey = new Map(items.map((i) => [i.key, i]));
  const pairs: ReviewItem[] = [];
  for (const m of matches.values()) {
    const n = names.get(m.key);
    if (m.status === "pinned" || scoreHitTrusted(m, n)) continue;
    const it = byKey.get(m.key);
    if (!it) continue;
    for (const c of m.candidates.slice(0, 3)) {
      const id = `${m.key}::${c.id}`;
      if (!opts.refresh && jev.pairs.has(id)) continue;
      pairs.push({
        id,
        state: {
          fileName: it.path.split("/").pop(),
          folder: it.collection,
          confirmedTitle: n?.title ?? it.title,
          confirmedAltTitles: n?.altTitles ?? it.altTitles,
          confirmedYear: n?.year ?? it.year,
          candidate: {
            title: c.title,
            originalTitle: c.originalTitle,
            year: c.year,
            overview: (c.overview ?? "").slice(0, 300),
          },
        },
      });
    }
  }
  return {
    pairBatches: opts.maxBatches > 0
      ? chunk(pairs, opts.batchSize).slice(0, opts.maxBatches)
      : chunk(pairs, opts.batchSize),
    pendingPairs: pairs.length,
  };
}

// --- Catalog building (pure) ---

type Details = {
  id: number;
  kind: "movie" | "tv";
  imdbId: string | null;
  title: string;
  originalTitle: string | null;
  originalLanguage: string | null;
  year: number | null;
  runtime: number | null;
  genres: string[];
  countries: string[];
  spokenLanguages: string[];
  overview: string | null;
  voteAverage: number | null;
  voteCount: number | null;
  certification: string | null;
  directors: string[];
  cast: { name: string; character: string }[];
  keywords: string[];
  collection: { id: number; name: string } | null;
  posterUrl: string | null;
  tmdbUrl: string;
};

const QUALITY_RES: Record<string, number> = {
  "2160p": 4,
  "1080p": 3,
  "720p": 2,
  "576p": 1,
  "480p": 1,
};
const QUALITY_SRC: Record<string, number> = {
  remux: 6,
  bluray: 5,
  "web-dl": 4,
  webrip: 3,
  hdtv: 2,
  dvd: 1.5,
  hdrip: 1.5,
  tvrip: 1,
  cam: 0,
};

/** Comparable quality rank: resolution dominates, then source, then HDR /
 * codec; an untagged file ranks 0. */
export function qualityRank(
  it: Pick<
    Item,
    "resolution" | "source" | "hdr" | "codec" | "disc"
  >,
): number {
  const res = it.resolution
    ? QUALITY_RES[it.resolution] ?? 0
    : it.disc === "bluray"
    ? 3
    : it.disc === "dvd"
    ? 1
    : 0;
  const src = it.disc === "bluray"
    ? 6
    : it.source
    ? QUALITY_SRC[it.source] ?? 0
    : 0;
  const hdr = it.hdr.includes("dv")
    ? 2
    : it.hdr.some((h) => h !== "sdr")
    ? 1
    : 0;
  const codec = it.codec === "hevc" || it.codec === "av1" ? 0.5 : 0;
  return res * 100 + src * 10 + hdr + codec;
}

/** A classified item joined with its resolved name and TMDB identity, as written to the library catalogue. */
export type FilmFact = Item & {
  nameStatus: NameDecision["status"];
  resolvedTitle: string | null;
  matchVia: Decision["via"] | "unqueried";
  matchConfidence: number | null;
  tmdbId: number | null;
  tmdb: Details | null;
  qualityRank: number;
  jevKind: string | null;
};

function titleKey(t: string, y: number | null): string {
  return `${
    t.normalize("NFKD").replace(/\p{M}+/gu, "").toLowerCase().replace(
      /[^\p{L}\p{N}]+/gu,
      "",
    )
  }|${y ?? ""}`;
}

/** Film facts: every entry the name step kept as a film (Jev's kind, or
 * the folder heuristic when Jev has not answered), joined with the TMDB
 * decision and details. */
export function buildFacts(
  items: Item[],
  names: Map<string, NameDecision>,
  decisions: Map<string, Decision>,
  titles: Map<string, Details>,
): FilmFact[] {
  const facts: FilmFact[] = [];
  for (const it of items) {
    const n = names.get(it.key);
    if (!n || n.status === "not-film") continue;
    const d = decisions.get(it.key);
    const tmdbId = d?.tmdbId ?? null;
    facts.push({
      ...it,
      class: "film",
      nameStatus: n.status,
      resolvedTitle: n.title,
      matchVia: d ? d.via : "unqueried",
      matchConfidence: d?.confidence ?? null,
      tmdbId,
      tmdb: tmdbId !== null
        ? titles.get(`${d!.tmdbKind}:${tmdbId}`) ?? null
        : null,
      qualityRank: qualityRank(it),
      jevKind: n.kind,
    });
  }
  return facts;
}

/** Count values of a multi-valued attribute across facts, with sizes. */
function rollup(
  facts: FilmFact[],
  values: (f: FilmFact) => (string | number | null | undefined)[],
): { value: string; films: number; bytes: number }[] {
  const m = new Map<string, { films: number; bytes: number }>();
  for (const f of facts) {
    const vs = [
      ...new Set(
        values(f).filter((v) => v !== null && v !== undefined && v !== ""),
      ),
    ];
    for (const v of vs.length ? vs : ["(unknown)"]) {
      const k = String(v);
      const cur = m.get(k) ?? { films: 0, bytes: 0 };
      cur.films++;
      cur.bytes += f.sizeBytes;
      m.set(k, cur);
    }
  }
  return [...m.entries()]
    .map(([value, c]) => ({ value, ...c }))
    .sort((a, b) => b.films - a.films || a.value.localeCompare(b.value));
}

const brief = (f: FilmFact) => ({
  key: f.key,
  role: f.role,
  path: f.path,
  title: f.tmdb?.title ?? f.title,
  year: f.tmdb?.year ?? f.year,
  tmdbId: f.tmdbId,
  resolution: f.resolution,
  source: f.source,
  sizeBytes: f.sizeBytes,
  qualityRank: f.qualityRank,
});

/** Dimensions and issue worklists over the facts. */
export function buildCube(
  items: Item[],
  facts: FilmFact[],
  names: Map<string, NameDecision>,
  decisions: Map<string, Decision>,
) {
  const library = facts.filter((f) => f.role === "library");
  const incoming = facts.filter((f) => f.role === "incoming");
  const idOf = (f: FilmFact) =>
    f.tmdbId !== null
      ? `tmdb:${f.tmdbId}`
      : `title:${titleKey(f.title, f.year)}`;

  const byId = new Map<string, FilmFact[]>();
  for (const f of library) {
    if (!f.title && f.tmdbId === null) continue;
    const k = idOf(f);
    if (!byId.has(k)) byId.set(k, []);
    byId.get(k)!.push(f);
  }
  const libraryDupes = [...byId.entries()]
    .filter(([, fs]) => fs.length >= 2)
    .map(([identity, fs]) => {
      const sorted = [...fs].sort((a, b) =>
        b.qualityRank - a.qualityRank || b.sizeBytes - a.sizeBytes
      );
      return {
        identity,
        title: brief(sorted[0]).title,
        year: brief(sorted[0]).year,
        keep: brief(sorted[0]),
        others: sorted.slice(1).map(brief),
        reclaimableBytes: sorted.slice(1).reduce((a, f) => a + f.sizeBytes, 0),
      };
    })
    .sort((a, b) => b.reclaimableBytes - a.reclaimableBytes);

  const incomingAlreadyOwned: {
    incoming: ReturnType<typeof brief>;
    library: ReturnType<typeof brief>;
    isUpgrade: boolean;
  }[] = [];
  const incomingToImport: ReturnType<typeof brief>[] = [];
  for (const f of incoming) {
    const owned = byId.get(idOf(f));
    if (owned && owned.length) {
      const best = owned.reduce((a, b) =>
        b.qualityRank > a.qualityRank ? b : a
      );
      incomingAlreadyOwned.push({
        incoming: brief(f),
        library: brief(best),
        isUpgrade: f.qualityRank > best.qualityRank,
      });
    } else incomingToImport.push(brief(f));
  }

  const unmatched = facts
    .filter((f) => f.tmdbId === null)
    .map((f) => {
      const d = decisions.get(f.key);
      return {
        ...brief(f),
        altTitles: f.altTitles,
        suspectTitle: f.suspectTitle,
        resolvedTitle: f.resolvedTitle,
        nameStatus: f.nameStatus,
        jevKind: f.jevKind,
        jevVerdict: d?.jevVerdict ?? "unasked",
        readings: names.get(f.key)?.readings ?? [],
        candidates: d?.candidates ?? [],
      };
    });

  const nonFilm = items
    .filter((i) =>
      i.class === "film" && names.get(i.key)?.status === "not-film"
    )
    .map((i) => ({
      path: i.path,
      title: i.title,
      jevKind: names.get(i.key)!.kind,
      jevKindConfidence: names.get(i.key)!.kindConfidence,
      sizeBytes: i.sizeBytes,
    }));

  const seriesInLibrary = items
    .filter((i) =>
      i.role === "library" && (i.class === "series" || i.class === "episode")
    )
    .map((i) => ({
      path: i.path,
      title: i.title,
      season: i.season,
      sizeBytes: i.sizeBytes,
    }));

  return {
    dims: {
      genres: rollup(facts, (f) => f.tmdb?.genres ?? []),
      decades: rollup(facts, (f) => {
        const y = f.tmdb?.year ?? f.year;
        return [y ? `${Math.floor(y / 10) * 10}s` : null];
      }),
      countries: rollup(facts, (f) => f.tmdb?.countries ?? []),
      languages: rollup(facts, (f) => [f.tmdb?.originalLanguage]),
      directors: rollup(facts, (f) => f.tmdb?.directors ?? []).filter((d) =>
        d.value !== "(unknown)"
      ),
      resolutions: rollup(facts, (f) => [f.resolution]),
      sources: rollup(facts, (f) => [f.source ?? f.disc]),
      hdr: rollup(facts, (f) => f.hdr.length ? f.hdr : ["none"]),
      collections: rollup(facts, (f) => [f.tmdb?.collection?.name]).filter(
        (d) => d.value !== "(unknown)",
      ),
    },
    issues: {
      unmatched,
      nonFilmInFilmFolders: nonFilm,
      libraryDupes,
      incomingAlreadyOwned,
      incomingToImport,
      seriesInLibrary,
      nonFilmIncoming: rollupOther(items.filter((i) => i.role === "incoming")),
      unknownDirs: items
        .filter((i) => i.class === "unknown")
        .map((i) => ({ path: i.path, role: i.role })),
      reclaimableBytes:
        libraryDupes.reduce((a, d) => a + d.reclaimableBytes, 0) +
        incomingAlreadyOwned
          .filter((x) => !x.isUpgrade)
          .reduce((a, x) => a + x.incoming.sizeBytes, 0),
    },
  };
}

function rollupOther(items: Item[]) {
  const m = new Map<
    string,
    { count: number; bytes: number; paths: string[] }
  >();
  for (const i of items) {
    if (i.class === "film") continue;
    const k = i.class === "other" ? `other:${i.otherKind}` : i.class;
    const cur = m.get(k) ?? { count: 0, bytes: 0, paths: [] };
    cur.count++;
    cur.bytes += i.sizeBytes;
    if (cur.paths.length < 50) cur.paths.push(i.path);
    m.set(k, cur);
  }
  return [...m.entries()].map(([kind, v]) => ({ kind, ...v })).sort((a, b) =>
    b.bytes - a.bytes
  );
}

function chunk<T>(xs: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
}

// --- Reading other models' data ---

/** Names of stored film facts that the current catalog no longer has. */
export function staleFactNames(
  existing: { name: string }[],
  facts: { key: string }[],
): string[] {
  const keep = new Set(facts.map((f) => f.key));
  return [...new Set(existing.map((r) => r.name))].filter((n) => !keep.has(n))
    .sort();
}

/** A readModelData/readResource row's parsed content. */
export function rowAttrs(row: unknown): Record<string, unknown> {
  if (!row || typeof row !== "object") return {};
  const o = row as Record<string, unknown>;
  for (const k of ["attributes", "content"]) {
    const v = o[k];
    if (v && typeof v === "object" && !Array.isArray(v)) {
      return v as Record<string, unknown>;
    }
    if (k === "content" && typeof v === "string") {
      try {
        return JSON.parse(v);
      } catch { /* fall through */ }
    }
  }
  return o;
}

/** Pick the newest row named `name` (by version, then createdAt). */
export function newestNamed(rows: unknown[], name: string): unknown | null {
  const named = rows.filter((r) =>
    (r as { name?: string } | null)?.name === name
  ) as { version?: number; createdAt?: string }[];
  if (named.length === 0) return null;
  named.sort((a, b) =>
    (b.version ?? 0) - (a.version ?? 0) ||
    String(b.createdAt ?? "").localeCompare(String(a.createdAt ?? ""))
  );
  return named[0];
}

/** Collect Jev answers from every triageBatch row named
 * `triage-batch-<set>-{kinds,names,pairs}-*`, newest version per name;
 * later batches override earlier ones per id. Answers are recognised by
 * question id (kind / correct_title / same_film), never by batch name. */
export function collectJev(rows: unknown[], set: string): JevAnswers {
  const pairs = new Map<string, number>();
  const names = new Map<string, number>();
  const kinds = new Map<string, { kind: string; confidence: number }>();
  const prefix = `triage-batch-${set}-`;
  const rowNames = new Set(
    rows
      .map((r) => (r as { name?: string } | null)?.name)
      .filter((n): n is string => !!n && n.startsWith(prefix)),
  );
  const newest = [...rowNames]
    .map((n) => rowAttrs(newestNamed(rows, n)))
    .sort((a, b) =>
      String(a.evaluatedAt ?? "").localeCompare(String(b.evaluatedAt ?? ""))
    );
  for (const content of newest) {
    for (const r of Array.isArray(content.results) ? content.results : []) {
      const id = (r as { id?: unknown }).id;
      const ans =
        (r as { answers?: Record<string, Record<string, unknown>> }).answers ??
          {};
      if (typeof id !== "string") continue;
      const same = ans.same_film;
      if (same && typeof same.noul === "number") pairs.set(id, same.noul);
      const title = ans.correct_title;
      if (title && typeof title.noul === "number") names.set(id, title.noul);
      const kind = ans.kind;
      if (kind && typeof kind.choice === "string") {
        kinds.set(id, {
          kind: kind.choice,
          confidence: typeof kind.confidence === "number" ? kind.confidence : 0,
        });
      }
    }
  }
  return { pairs, kinds, names };
}

function readMatches(rows: unknown[], set: string) {
  const content = rowAttrs(newestNamed(rows, set));
  const matches = new Map<string, MatchEntry>();
  for (const e of Array.isArray(content.entries) ? content.entries : []) {
    const me = e as MatchEntry;
    if (me && typeof me.key === "string") matches.set(me.key, me);
  }
  return { matches, found: Array.isArray(content.entries) };
}

// --- Resource schemas ---

const ItemSchema = z.object({
  key: z.string(),
  role: z.enum(["library", "incoming"]),
  root: z.string(),
  path: z.string(),
  rel: z.string(),
  entryType: z.enum(["file", "dir"]),
  class: z.enum([
    "film",
    "series",
    "episode",
    "subtitle",
    "other",
    "junk",
    "unknown",
  ]),
  otherKind: z.string().nullable(),
  collection: z.string().nullable(),
  title: z.string(),
  altTitles: z.array(z.string()),
  year: z.number().nullable(),
  edition: z.string().nullable(),
  resolution: z.string().nullable(),
  source: z.string().nullable(),
  codec: z.string().nullable(),
  hdr: z.array(z.string()),
  audio: z.array(z.string()),
  langTags: z.array(z.string()),
  group: z.string().nullable(),
  is3D: z.boolean(),
  season: z.number().nullable(),
  episode: z.number().nullable(),
  disc: z.enum(["bluray", "dvd"]).nullable(),
  container: z.string().nullable(),
  mainFile: z.string().nullable(),
  videoFiles: z.number(),
  subtitleFiles: z.number(),
  sizeBytes: z.number(),
  sizeComplete: z.boolean(),
  mtime: z.number(),
  suspectTitle: z.boolean(),
});

const MatchQuerySchema = z.object({
  key: z.string(),
  title: z.string(),
  altTitles: z.array(z.string()),
  year: z.number().nullable(),
  kind: z.enum(["movie", "tv"]),
  tmdbId: z.number().optional(),
});

const InventorySchema = z.object({
  kind: z.literal("inventory"),
  roots: z.array(z.object({ path: z.string(), role: z.string() })),
  missingRoots: z.array(z.string()),
  maxDepth: z.number(),
  entriesListed: z.number(),
  items: z.array(ItemSchema),
  stats: z.record(z.string(), z.record(z.string(), z.number())),
  scannedAt: z.string(),
});

const ReviewItemSchema = z.object({
  id: z.string(),
  state: z.record(z.string(), z.unknown()),
});

const NameDecisionSchema = z.object({
  key: z.string(),
  kind: z.string().nullable(),
  kindConfidence: z.number().nullable(),
  status: z.enum([
    "confirmed",
    "uncertain",
    "parser",
    "rejected",
    "not-film",
    "pinned",
  ]),
  title: z.string().nullable(),
  altTitles: z.array(z.string()),
  year: z.number().nullable(),
  readings: z.array(z.object({
    id: z.string(),
    title: z.string(),
    year: z.number().nullable(),
    p: z.number().nullable(),
  })),
});

const NamesSchema = z.object({
  kind: z.literal("names"),
  decisions: z.array(NameDecisionSchema),
  /** Films to search — hand to tmdb `match` as `items`. */
  matchQueries: z.array(MatchQuerySchema),
  /** Jev batches still to ask — each goes to typesafe-batch triage_batch. */
  kindBatches: z.array(z.array(ReviewItemSchema)),
  nameBatches: z.array(z.array(ReviewItemSchema)),
  kindQuestions: z.record(z.string(), z.unknown()),
  nameQuestions: z.record(z.string(), z.unknown()),
  stats: z.record(z.string(), z.number()),
  decidedAt: z.string(),
});

const DecisionSchema = z.object({
  key: z.string(),
  tmdbId: z.number().nullable(),
  tmdbKind: z.enum(["movie", "tv"]),
  via: z.enum(["pinned", "jev", "score", "none"]),
  confidence: z.number().nullable(),
  jevVerdict: z.enum(["accepted", "rejected-all", "undecided", "unasked"]),
  candidates: z.array(z.object({
    id: z.number(),
    title: z.string(),
    year: z.number().nullable(),
    p: z.number().nullable(),
    score: z.number().nullable(),
  })),
});

const ResolutionSchema = z.object({
  kind: z.literal("resolution"),
  decisions: z.array(DecisionSchema),
  /** Distinct TMDB ids to enrich — hand to tmdb `enrich`. */
  enrichIds: z.array(
    z.object({ id: z.number(), kind: z.enum(["movie", "tv"]) }),
  ),
  /** Jev batches for ambiguous searches — each to triage_batch. */
  pairBatches: z.array(z.array(ReviewItemSchema)),
  pairQuestions: z.record(z.string(), z.unknown()),
  stats: z.record(z.string(), z.number()),
  resolvedAt: z.string(),
});

const FilmSchema = ItemSchema.extend({
  nameStatus: z.string(),
  resolvedTitle: z.string().nullable(),
  matchVia: z.string(),
  matchConfidence: z.number().nullable(),
  tmdbId: z.number().nullable(),
  tmdb: z.record(z.string(), z.unknown()).nullable(),
  qualityRank: z.number(),
  jevKind: z.string().nullable(),
  catalogedAt: z.string(),
});

const DimensionSchema = z.object({
  kind: z.literal("dimension"),
  dimension: z.string(),
  entries: z.array(
    z.object({ value: z.string(), films: z.number(), bytes: z.number() }),
  ),
  catalogedAt: z.string(),
});

const IssuesSchema = z.object({
  kind: z.literal("issues"),
  unmatched: z.array(z.record(z.string(), z.unknown())),
  nonFilmInFilmFolders: z.array(z.record(z.string(), z.unknown())),
  libraryDupes: z.array(z.record(z.string(), z.unknown())),
  incomingAlreadyOwned: z.array(z.record(z.string(), z.unknown())),
  incomingToImport: z.array(z.record(z.string(), z.unknown())),
  seriesInLibrary: z.array(z.record(z.string(), z.unknown())),
  nonFilmIncoming: z.array(z.record(z.string(), z.unknown())),
  unknownDirs: z.array(z.record(z.string(), z.unknown())),
  reclaimableBytes: z.number(),
  catalogedAt: z.string(),
});

const LibrarySchema = z.object({
  kind: z.literal("library"),
  films: z.number(),
  libraryFilms: z.number(),
  incomingFilms: z.number(),
  byName: z.record(z.string(), z.number()),
  byVia: z.record(z.string(), z.number()),
  enriched: z.number(),
  totalBytes: z.number(),
  libraryBytes: z.number(),
  incomingBytes: z.number(),
  totalRuntimeMinutes: z.number(),
  classCounts: z.record(z.string(), z.number()),
  dimensionCardinality: z.record(z.string(), z.number()),
  issueCounts: z.record(z.string(), z.number()),
  reclaimableBytes: z.number(),
  catalogedAt: z.string(),
});

type Ctx = {
  readResource: (n: string) => Promise<unknown>;
};

async function readInventory(context: Ctx): Promise<Item[]> {
  const inv = rowAttrs(await context.readResource("inventory"));
  if (!Array.isArray(inv.items)) {
    throw new Error("no inventory yet — run the scan method first");
  }
  return inv.items as Item[];
}

async function readNames(context: Ctx): Promise<NameDecision[]> {
  const n = rowAttrs(await context.readResource("names"));
  if (!Array.isArray(n.decisions)) {
    throw new Error("no name decisions yet — run the names method first");
  }
  return n.decisions as NameDecision[];
}

const reviewArgs = {
  batchSize: z
    .number()
    .int()
    .min(1)
    .max(100)
    .default(100)
    .describe("Items per Jev batch (typesafe-batch max 100)"),
  maxBatches: z
    .number()
    .int()
    .min(0)
    .default(0)
    .describe("Cap batches per question type this run (0 = all)"),
  refresh: z
    .boolean()
    .default(false)
    .describe("Re-ask Jev about items it already answered"),
};

// --- Model ---

/** @magistr/film-library model: scan film shares, let Jev resolve each
 * entry's name and kind, search TMDB with the confirmed name, and catalog
 * the enriched result as a star-schema cube. */
export const model = {
  type: "@magistr/film-library",
  version: "2026.10.15.3",
  upgrades: [
    {
      toVersion: "2026.10.15.1",
      description: "Version bump — repo-wide republish; no schema change",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.10.15.2",
      description: "Version bump — repo-wide republish; no schema change",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.10.15.3",
      description: "Version bump — repo-wide republish; no schema change",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
  ],
  globalArguments: GlobalArgsSchema,
  resources: {
    removals: {
      description:
        "Outcome of deleting downloads already in the library (remove-downloads)",
      schema: RemovalsSchema,
      lifetime: "infinite",
      garbageCollection: 5,
    },
    imports: {
      description: "Outcome of moving downloads into the library (import)",
      schema: ImportsSchema,
      lifetime: "infinite",
      garbageCollection: 5,
    },
    inventory: {
      description:
        "Every top-level entry of the film roots, classified and name-parsed",
      schema: InventorySchema,
      lifetime: "infinite",
      garbageCollection: 5,
    },
    names: {
      description:
        "Jev-resolved kind and title per entry, TMDB search queries, and the Jev name/kind batches still to ask",
      schema: NamesSchema,
      lifetime: "infinite",
      garbageCollection: 5,
    },
    resolution: {
      description:
        "Per-film TMDB id decisions, ids to enrich, and the Jev batches for ambiguous searches",
      schema: ResolutionSchema,
      lifetime: "infinite",
      garbageCollection: 5,
    },
    film: {
      description:
        "Film fact: one file or folder with parsed tags, resolved name and TMDB metadata",
      schema: FilmSchema,
      lifetime: "infinite",
      garbageCollection: 3,
    },
    dimension: {
      description:
        "Rollup dimension (genres / decades / countries / languages / directors / resolutions / sources / hdr / collections)",
      schema: DimensionSchema,
      lifetime: "infinite",
      garbageCollection: 5,
    },
    issues: {
      description:
        "Worklists: unmatched, non-film in film folders, library duplicates, downloads already owned / to import, series in library, non-film downloads",
      schema: IssuesSchema,
      lifetime: "infinite",
      garbageCollection: 5,
    },
    library: {
      description:
        "Catalog summary with counts, sizes and dimension cardinalities",
      schema: LibrarySchema,
      lifetime: "infinite",
      garbageCollection: 5,
    },
  },
  methods: {
    scan: {
      description:
        "List the film roots (bounded depth, one SSH session), classify and parse every entry, and write the inventory",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const g: GlobalArgs = GlobalArgsSchema.parse(context.globalArgs);
        const paths = g.roots.map((r) => r.path.replace(/\/+$/, ""));
        const raw = await sshRun(
          g.host,
          g.sshUser,
          `bash -s -- ${g.maxDepth} ${paths.map(shQuote).join(" ")}`,
          LIST_SCRIPT,
        );
        const listing = parseListing(raw);
        const ignore = [...new Set(g.ignore)];
        const items: Item[] = [];
        for (const r of g.roots) {
          const root = r.path.replace(/\/+$/, "");
          const entries = listing.entries.filter((e) =>
            e.root === root &&
            !ignore.some((p) => e.path === p || e.path.startsWith(p + "/"))
          );
          items.push(...classifyRoot(root, r.role, entries, g.maxDepth));
        }
        const stats: Record<string, Record<string, number>> = {};
        for (const it of items) {
          stats[it.role] ??= {};
          stats[it.role][it.class] = (stats[it.role][it.class] ?? 0) + 1;
        }
        const handle = await context.writeResource("inventory", "inventory", {
          kind: "inventory",
          roots: g.roots,
          missingRoots: listing.missingRoots,
          maxDepth: g.maxDepth,
          entriesListed: listing.entries.length,
          items,
          stats,
          scannedAt: new Date().toISOString(),
        });
        context.logger?.info?.(
          `scan: ${listing.entries.length} entries → ${items.length} items; ${
            JSON.stringify(stats)
          }${
            listing.missingRoots.length
              ? `; MISSING roots: ${listing.missingRoots.join(", ")}`
              : ""
          }`,
        );
        return { dataHandles: [handle] };
      },
    },
    names: {
      description:
        "Resolve each entry's kind and title from Jev's answers (parser readings as fallback), write the TMDB search queries and the Jev name/kind questions still open",
      arguments: z.object({
        nameThreshold: z
          .number()
          .min(0)
          .max(1)
          .default(0.6)
          .describe("Jev P needed to confirm a reading of the name"),
        rejectBelow: z
          .number()
          .min(0)
          .max(1)
          .default(0.3)
          .describe(
            "Below this Jev P every reading is rejected and the entry is not searched; between this and nameThreshold it is searched as uncertain",
          ),
        kindThreshold: z
          .number()
          .min(0)
          .max(1)
          .default(0.85)
          .describe(
            "Jev confidence needed for its kind to override the folder heuristic",
          ),
        ...reviewArgs,
      }),
      execute: async (args, context) => {
        const g: GlobalArgs = GlobalArgsSchema.parse(context.globalArgs);
        const items = await readInventory(context);
        const jevRows: unknown[] = await context
          .readModelData(g.jevInstance, "triageBatch")
          .catch(() => []);
        const jev = collectJev(jevRows ?? [], g.setName);
        const decisions = decideNames(items, jev, g.overrides, {
          ...args,
          kinds: g.kinds,
        });
        const matchQueries = buildMatchQueries(items, decisions, g.overrides);
        const review = buildNameReview(items, jev, args);
        const by = (s: NameDecision["status"]) =>
          decisions.filter((d) => d.status === s).length;
        const stats = {
          entries: decisions.length,
          confirmed: by("confirmed"),
          parser: by("parser"),
          rejected: by("rejected"),
          notFilm: by("not-film"),
          pinned: by("pinned"),
          matchQueries: matchQueries.length,
          jevKindsAnswered: jev.kinds.size,
          jevNamesAnswered: jev.names.size,
          pendingKinds: review.pendingKinds,
          pendingNames: review.pendingNames,
        };
        const handle = await context.writeResource("names", "names", {
          kind: "names",
          decisions,
          matchQueries,
          kindBatches: review.kindBatches,
          nameBatches: review.nameBatches,
          kindQuestions: JEV_KIND_QUESTIONS,
          nameQuestions: JEV_NAME_QUESTIONS,
          stats,
          decidedAt: new Date().toISOString(),
        });
        context.logger?.info?.(`names: ${JSON.stringify(stats)}`);
        return { dataHandles: [handle] };
      },
    },
    resolve: {
      description:
        "Decide each searched film's TMDB id: clear search hits are accepted, ambiguous ones go to Jev; write the ids to enrich and the Jev questions still open",
      arguments: z.object({
        threshold: z
          .number()
          .min(0.5)
          .max(1)
          .default(0.5)
          .describe("Jev P(same film) needed to accept a candidate"),
        margin: z
          .number()
          .min(0)
          .max(1)
          .default(0.1)
          .describe("Required lead of the accepted candidate over the next"),
        ...reviewArgs,
      }),
      execute: async (args, context) => {
        const g: GlobalArgs = GlobalArgsSchema.parse(context.globalArgs);
        const items = await readInventory(context);
        const names = new Map(
          (await readNames(context)).map((n) => [n.key, n]),
        );
        const matchRows: unknown[] = await context
          .readModelData(g.tmdbInstance, "match")
          .catch(() => []);
        const { matches: all, found } = readMatches(matchRows ?? [], g.setName);
        if (!found) {
          throw new Error(
            `resolve: tmdb instance "${g.tmdbInstance}" has no match set "${g.setName}" — run its match method with the names resource's matchQueries and name=${g.setName}`,
          );
        }
        // Only entries the current name step still sends to TMDB count.
        const matches = new Map(
          [...all].filter(([k]) => {
            return SEARCHED.has(names.get(k)?.status ?? "");
          }),
        );
        const jevRows: unknown[] = await context
          .readModelData(g.jevInstance, "triageBatch")
          .catch(() => []);
        const jev = collectJev(jevRows ?? [], g.setName);
        const decisions = decide(matches, names, jev, args);
        const review = buildPairReview(items, names, matches, jev, args);
        const seen = new Set<string>();
        const enrichIds: { id: number; kind: "movie" | "tv" }[] = [];
        for (const d of decisions) {
          if (d.tmdbId === null) continue;
          const k = `${d.tmdbKind}:${d.tmdbId}`;
          if (seen.has(k)) continue;
          seen.add(k);
          enrichIds.push({ id: d.tmdbId, kind: d.tmdbKind });
        }
        const by = (v: Decision["via"]) =>
          decisions.filter((d) => d.via === v).length;
        const stats = {
          searched: decisions.length,
          pinned: by("pinned"),
          score: by("score"),
          jev: by("jev"),
          none: by("none"),
          jevRejectedAll:
            decisions.filter((d) => d.jevVerdict === "rejected-all").length,
          jevUndecided:
            decisions.filter((d) => d.jevVerdict === "undecided").length,
          jevPairsAnswered: jev.pairs.size,
          pendingPairs: review.pendingPairs,
          enrichIds: enrichIds.length,
        };
        const handle = await context.writeResource("resolution", "resolution", {
          kind: "resolution",
          decisions,
          enrichIds,
          pairBatches: review.pairBatches,
          pairQuestions: JEV_PAIR_QUESTIONS,
          stats,
          resolvedAt: new Date().toISOString(),
        });
        context.logger?.info?.(`resolve: ${JSON.stringify(stats)}`);
        return { dataHandles: [handle] };
      },
    },
    import: {
      description:
        "Move downloaded films (files or folders under an incoming root) into a library root on the host, in one SSH session. Never overwrites: an existing destination is a conflict; a source already gone with the destination present counts as already imported. For torrent-backed downloads use the transmission model's relocate instead, so seeding follows the files",
      arguments: z.object({
        paths: z
          .array(z.string())
          .min(1)
          .describe("Absolute host paths of entries under an incoming root"),
        target: z
          .string()
          .optional()
          .describe(
            "Library root to move into (default: the first library root)",
          ),
      }),
      execute: async (args, context) => {
        const g: GlobalArgs = GlobalArgsSchema.parse(context.globalArgs);
        const strip = (p: string) => p.replace(/\/+$/, "");
        const incoming = g.roots.filter((r) => r.role === "incoming").map((r) =>
          strip(r.path)
        );
        const library = g.roots.filter((r) => r.role === "library").map((r) =>
          strip(r.path)
        );
        const target = strip(args.target ?? library[0] ?? "");
        if (!library.includes(target)) {
          throw new Error(`target ${target} is not a library root`);
        }
        for (const p of args.paths) {
          const parent = strip(p).split("/").slice(0, -1).join("/");
          if (!incoming.includes(parent)) {
            throw new Error(
              `${p} is not a top-level entry of an incoming root`,
            );
          }
        }
        const raw = await sshRun(
          g.host,
          g.sshUser,
          `bash -s -- ${shQuote(target)} ${
            args.paths.map((p) => shQuote(strip(p))).join(" ")
          }`,
          IMPORT_SCRIPT,
          6 * 3600_000,
        );
        const outcomes = raw.trim().split("\n").filter(Boolean).map((l) => {
          const [result, path, dest] = l.split("\t");
          return { result, path, dest };
        });
        const handle = await context.writeResource("imports", "import", {
          target,
          outcomes,
          moved: outcomes.filter((o) => o.result === "MOVED").length,
          failed: outcomes.filter((o) =>
            !["MOVED", "ALREADY"].includes(o.result)
          ).length,
          importedAt: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },
    "remove-downloads": {
      description:
        "Delete downloads that are already in the library. Each item names the download (under an incoming root, any depth) and its library copy (under a library root); the download is deleted only if the library copy exists at that moment. Torrent-backed downloads should go through the transmission model's remove-torrent instead",
      arguments: z.object({
        items: z
          .array(z.object({ path: z.string(), libraryCopy: z.string() }))
          .min(1),
      }),
      execute: async (args, context) => {
        const g: GlobalArgs = GlobalArgsSchema.parse(context.globalArgs);
        const strip = (p: string) => p.replace(/\/+$/, "");
        const under = (p: string, role: string) =>
          g.roots.some((r) =>
            r.role === role && strip(p).startsWith(strip(r.path) + "/")
          );
        for (const it of args.items) {
          if (!under(it.path, "incoming")) {
            throw new Error(`${it.path} is not under an incoming root`);
          }
          if (!under(it.libraryCopy, "library")) {
            throw new Error(`${it.libraryCopy} is not under a library root`);
          }
        }
        const raw = await sshRun(
          g.host,
          g.sshUser,
          `bash -s -- ${
            args.items.flatMap((
              i,
            ) => [shQuote(strip(i.path)), shQuote(strip(i.libraryCopy))]).join(
              " ",
            )
          }`,
          REMOVE_SCRIPT,
        );
        const outcomes = raw.trim().split("\n").filter(Boolean).map((l) => {
          const [result, path, bytes] = l.split("\t");
          return { result, path, bytes: Number(bytes) || 0 };
        });
        const handle = await context.writeResource(
          "removals",
          "remove-downloads",
          {
            outcomes,
            deleted: outcomes.filter((o) => o.result === "DELETED").length,
            freedBytes: outcomes.filter((o) => o.result === "DELETED").reduce(
              (a, o) => a + o.bytes,
              0,
            ),
            removedAt: new Date().toISOString(),
          },
        );
        return { dataHandles: [handle] };
      },
    },
    catalog: {
      description:
        "Join inventory, names, resolution and TMDB enrichment into film facts, dimensions, issue worklists and a summary",
      arguments: z.object({
        writeFacts: z
          .boolean()
          .default(true)
          .describe("Write one film resource per film (false = cube only)"),
      }),
      execute: async (args, context) => {
        const g: GlobalArgs = GlobalArgsSchema.parse(context.globalArgs);
        const items = await readInventory(context);
        const names = new Map(
          (await readNames(context)).map((n) => [n.key, n]),
        );
        const res = rowAttrs(await context.readResource("resolution"));
        if (!Array.isArray(res.decisions)) {
          throw new Error("catalog: no resolution yet — run resolve first");
        }
        const decisions = new Map<string, Decision>(
          (res.decisions as Decision[]).map((d) => [d.key, d]),
        );
        const titleRows: unknown[] = await context
          .readModelData(g.tmdbInstance, "titles")
          .catch(() => []);
        const tc = rowAttrs(newestNamed(titleRows ?? [], g.setName));
        const titles = new Map<string, Details>();
        for (
          const t of Object.values((tc.titles ?? {}) as Record<string, Details>)
        ) {
          if (t && typeof t.id === "number") titles.set(`${t.kind}:${t.id}`, t);
        }

        const facts = buildFacts(items, names, decisions, titles);
        const cube = buildCube(items, facts, names, decisions);
        const catalogedAt = new Date().toISOString();
        const handles: unknown[] = [];
        if (args.writeFacts) {
          for (const f of facts) {
            handles.push(
              await context.writeResource("film", f.key, {
                ...f,
                tmdb: f.tmdb as unknown as Record<string, unknown> | null,
                catalogedAt,
              }),
            );
          }
          // Facts of entries no longer on disk (moved, deleted) would
          // otherwise linger and double-count: drop every film fact this
          // run did not write.
          const stored = (await context.dataRepository.findAllForModel(
            context.modelType,
            context.modelId,
          )) as {
            name: string;
            tags?: Record<string, string>;
            metadata?: { tags?: Record<string, string>; lifecycle?: string };
          }[];
          const existing = stored.filter((d) =>
            (d.tags?.specName ?? d.metadata?.tags?.specName) === "film" &&
            d.metadata?.lifecycle !== "deleted"
          );
          for (const name of staleFactNames(existing, facts)) {
            await context.deleteResource(name);
          }
        }
        for (const [name, entries] of Object.entries(cube.dims)) {
          handles.push(
            await context.writeResource("dimension", `dim-${name}`, {
              kind: "dimension",
              dimension: name,
              entries,
              catalogedAt,
            }),
          );
        }
        handles.push(
          await context.writeResource("issues", "issues", {
            kind: "issues",
            ...cube.issues,
            catalogedAt,
          }),
        );
        const count = (f: (x: FilmFact) => string) => {
          const o: Record<string, number> = {};
          for (const x of facts) o[f(x)] = (o[f(x)] ?? 0) + 1;
          return o;
        };
        const sum = (fs: FilmFact[]) => fs.reduce((a, f) => a + f.sizeBytes, 0);
        const classCounts: Record<string, number> = {};
        for (const it of items) {
          const k = `${it.role}:${it.class}`;
          classCounts[k] = (classCounts[k] ?? 0) + 1;
        }
        const summary = {
          kind: "library" as const,
          films: facts.length,
          libraryFilms: facts.filter((f) => f.role === "library").length,
          incomingFilms: facts.filter((f) => f.role === "incoming").length,
          byName: count((f) => f.nameStatus),
          byVia: count((f) => f.matchVia),
          enriched: facts.filter((f) => f.tmdb !== null).length,
          totalBytes: sum(facts),
          libraryBytes: sum(facts.filter((f) => f.role === "library")),
          incomingBytes: sum(facts.filter((f) => f.role === "incoming")),
          totalRuntimeMinutes: facts.reduce(
            (a, f) => a + (f.tmdb?.runtime ?? 0),
            0,
          ),
          classCounts,
          dimensionCardinality: Object.fromEntries(
            Object.entries(cube.dims).map(([k, v]) => [k, v.length]),
          ),
          issueCounts: Object.fromEntries(
            Object.entries(cube.issues)
              .filter(([, v]) => Array.isArray(v))
              .map(([k, v]) => [k, (v as unknown[]).length]),
          ),
          reclaimableBytes: cube.issues.reclaimableBytes,
          catalogedAt,
        };
        handles.push(
          await context.writeResource("library", "summary", summary),
        );
        context.logger?.info?.(
          `catalog: ${summary.films} films, ${summary.enriched} enriched; names ${
            JSON.stringify(summary.byName)
          }; via ${JSON.stringify(summary.byVia)}; issues ${
            JSON.stringify(summary.issueCounts)
          }`,
        );
        return { dataHandles: handles };
      },
    },
  },
};
