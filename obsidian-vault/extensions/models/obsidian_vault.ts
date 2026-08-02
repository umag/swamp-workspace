/**
 * Obsidian vault model with two interchangeable backends.
 *
 * The CLI backend drives the official `obsidian` binary and can do everything
 * Obsidian's own index can do — tags, links, backlinks, orphans, unresolved
 * links, daily notes, and moves that rewrite wikilinks. It requires the desktop
 * app to be running.
 *
 * The filesystem backend operates directly on a mounted vault directory and
 * needs nothing running. It covers every method that only ever touches markdown
 * files, which makes the model usable from `swamp serve`, cron, and containers.
 *
 * Frontmatter is handled through a real YAML document rather than line
 * matching. That is deliberate: a scalar-only parser silently destroys
 * block-style lists, and `tags:` / `aliases:` lists are the most common
 * frontmatter shape Obsidian produces.
 *
 * @module
 */
import { z } from "npm:zod@4";
import YAML from "npm:yaml@2.6.1";

// --- Configuration -------------------------------------------------------

const GlobalArgsSchema = z.object({
  vault: z.string().optional().describe(
    "Registered Obsidian vault name. Required for the CLI backend; also used to look up vaultRoot in Obsidian's vault registry when vaultRoot is not given.",
  ),
  vaultRoot: z.string().optional().describe(
    "Absolute path to the vault directory. Setting it enables the headless filesystem backend. Takes precedence over the registry lookup.",
  ),
  backend: z.enum(["auto", "cli", "fs"]).default("auto").describe(
    "Which backend to use: 'auto' picks fs when vaultRoot is set and cli otherwise; 'cli' always shells to the Obsidian binary (needs the desktop app running); 'fs' always reads the vault directory and refuses methods that need Obsidian's index.",
  ),
  blockDotObsidian: z.boolean().default(true).describe(
    "Refuse to read or write inside .obsidian unless a method is called with allowDotObsidian=true.",
  ),
  defaultFileMode: z.number().int().default(0o644).describe(
    "Permission mode applied to files the filesystem backend creates.",
  ),
  defaultDirectoryMode: z.number().int().default(0o755).describe(
    "Permission mode applied to directories the filesystem backend creates.",
  ),
});

// --- Resource schemas ----------------------------------------------------

const NoteSchema = z.object({
  file: z.string(),
  content: z.string(),
  timestamp: z.iso.datetime(),
});

// `exists` and `modifiedAt` are new; the previously required metadata fields
// are optional so a missing file is not reported as a zero-byte epoch file.
// Relaxing required to optional is backward-safe for already-stored artifacts.
const FileInfoSchema = z.object({
  path: z.string(),
  name: z.string().optional(),
  extension: z.string().optional(),
  size: z.number().optional(),
  created: z.number().optional(),
  modified: z.number().optional(),
  exists: z.boolean().default(true),
  modifiedAt: z.string().optional(),
  timestamp: z.iso.datetime(),
});

const NotesSchema = z.object({
  files: z.array(z.string()),
  count: z.number(),
  truncated: z.boolean().default(false),
  timestamp: z.iso.datetime(),
});

const SearchResultSchema = z.object({
  query: z.string(),
  results: z.array(z.object({
    file: z.string(),
    matches: z.array(z.object({
      line: z.number(),
      text: z.string(),
    })),
  })),
  count: z.number(),
  truncated: z.boolean().default(false),
  timestamp: z.iso.datetime(),
});

const TagsSchema = z.object({
  tags: z.array(z.object({
    tag: z.string(),
    count: z.number().optional(),
  })),
  count: z.number(),
  timestamp: z.iso.datetime(),
});

const TagFilesSchema = z.object({
  tag: z.string(),
  files: z.array(z.string()),
  count: z.number(),
  timestamp: z.iso.datetime(),
});

const LinksSchema = z.object({
  file: z.string(),
  direction: z.enum(["outgoing", "incoming"]),
  links: z.array(z.string()),
  count: z.number(),
  timestamp: z.iso.datetime(),
});

const UnresolvedSchema = z.object({
  links: z.array(z.object({
    link: z.string(),
    count: z.number().optional(),
  })),
  count: z.number(),
  timestamp: z.iso.datetime(),
});

const DailyNoteSchema = z.object({
  content: z.string(),
  path: z.string().optional(),
  timestamp: z.iso.datetime(),
});

const PropertiesSchema = z.object({
  file: z.string(),
  properties: z.record(z.string(), z.unknown()),
  timestamp: z.iso.datetime(),
});

const OperationResultSchema = z.object({
  operation: z.string(),
  file: z.string().optional(),
  success: z.boolean(),
  action: z.enum(["created", "updated", "unchanged", "appended", "removed"])
    .optional(),
  bytes: z.number().optional(),
  message: z.string().optional(),
  timestamp: z.iso.datetime(),
});

const CorpusSchema = z.object({
  folder: z.string(),
  generatedAt: z.iso.datetime(),
  fileCount: z.number(),
  totalWords: z.number(),
  truncated: z.boolean(),
  dateRange: z.object({
    earliest: z.string().nullable(),
    latest: z.string().nullable(),
  }),
  signalRollups: z.array(z.object({
    keyword: z.string(),
    count: z.number(),
    files: z.array(z.string()),
  })),
  signalHits: z.array(z.object({
    keyword: z.string(),
    file: z.string(),
    line: z.string(),
  })),
  files: z.array(z.object({
    file: z.string(),
    inferredDate: z.string().nullable(),
    headings: z.array(z.string()),
    wikilinks: z.array(z.string()),
    tags: z.array(z.string()),
    prRefs: z.array(z.string()),
    ticketRefs: z.array(z.string()),
    wordCount: z.number(),
    body: z.string().optional(),
  })),
});

// --- Backend capability --------------------------------------------------

/** Methods that need Obsidian's own index and cannot be served from the filesystem. */
export const CLI_ONLY_METHODS: ReadonlySet<string> = new Set([
  "backlinks",
  "daily",
  "dailyAppend",
  "dailyPrepend",
  "dailyRead",
  "links",
  "move",
  "orphans",
  "tag",
  "tags",
  "unresolved",
]);

/** Closest headless method for each CLI-only method, used in error messages. */
const HEADLESS_ALTERNATIVE: Record<string, string> = {
  backlinks: "search",
  links: "digest",
  orphans: "digest",
  tag: "search",
  tags: "digest",
  unresolved: "digest",
};

/** Resolve which backend serves a method, or explain why it cannot be served. */
export function selectBackend(
  globalArgs: Record<string, unknown>,
  methodName: string,
): "cli" | "fs" {
  const backend = (globalArgs.backend as string) ?? "auto";
  const hasRoot = typeof globalArgs.vaultRoot === "string" &&
    globalArgs.vaultRoot.length > 0;

  if (CLI_ONLY_METHODS.has(methodName)) {
    if (backend === "fs") {
      const alt = HEADLESS_ALTERNATIVE[methodName];
      throw new Error(
        `Method "${methodName}" needs Obsidian's link and tag index, not just the note files, ` +
          `so it cannot run on the filesystem backend. Setting vaultRoot does not help. ` +
          `Use backend=auto or backend=cli with the Obsidian desktop app running` +
          (alt ? `, or use "${alt}" for a headless approximation.` : "."),
      );
    }
    return "cli";
  }

  if (backend === "cli") return "cli";
  if (backend === "fs") return "fs";
  return hasRoot ? "fs" : "cli";
}

// --- Path confinement ----------------------------------------------------

export interface VaultPath {
  absolutePath: string;
  vaultRelativePath: string;
  /**
   * The vault root with every symlink resolved. Callers that turn walked
   * absolute paths back into vault-relative ones must compare against this,
   * not against the configured vaultRoot — on macOS a temp or synced vault
   * reached via /var resolves to /private/var, and a raw prefix check silently
   * fails, leaking absolute paths into the data model.
   */
  realRoot: string;
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function normalizeSegments(path: string): string[] {
  const segments: string[] = [];
  for (const raw of path.split(/[/\\]/)) {
    if (!raw || raw === ".") continue;
    if (raw === "..") {
      if (segments.length === 0) {
        throw new Error(`Path escapes vault root: ${path}`);
      }
      segments.pop();
      continue;
    }
    segments.push(raw);
  }
  return segments;
}

/** True for a path segment Obsidian keeps out of the note tree. */
export function isHiddenSegment(name: string): boolean {
  return name.startsWith(".");
}

/**
 * Resolve a caller-supplied path against the vault root, rejecting anything
 * that leaves it. String-level only — see resolveVaultPathSafe for the
 * symlink-aware form used before any filesystem access.
 */
export function resolveVaultPath(
  globalArgs: Record<string, unknown>,
  requestedPath: string,
  options: { allowDotObsidian?: boolean } = {},
): VaultPath {
  const rootArg = globalArgs.vaultRoot;
  if (typeof rootArg !== "string" || rootArg.length === 0) {
    throw new Error(
      "vaultRoot is not set — the filesystem backend needs it. Set the vaultRoot global argument, or use backend=cli.",
    );
  }
  const normalizedVaultRoot = "/" +
    normalizeSegments(trimTrailingSlash(rootArg)).join("/");

  let relativeCandidate: string;
  if (requestedPath.startsWith("/")) {
    const normalizedRequested = "/" +
      normalizeSegments(requestedPath).join("/");
    if (
      normalizedRequested !== normalizedVaultRoot &&
      !normalizedRequested.startsWith(`${normalizedVaultRoot}/`)
    ) {
      throw new Error(
        `Path is outside vault root. vaultRoot=${normalizedVaultRoot} requested=${normalizedRequested}`,
      );
    }
    relativeCandidate = normalizedRequested.slice(normalizedVaultRoot.length)
      .replace(/^\//, "");
  } else {
    relativeCandidate = requestedPath.replace(/^\/+/, "");
  }

  const relativeSegments = normalizeSegments(relativeCandidate);
  if (
    globalArgs.blockDotObsidian !== false && !options.allowDotObsidian &&
    relativeSegments.some((segment) => segment === ".obsidian")
  ) {
    throw new Error(
      "Refusing to operate on .obsidian internals unless allowDotObsidian=true",
    );
  }

  const vaultRelativePath = relativeSegments.join("/");
  return {
    absolutePath: vaultRelativePath
      ? `${normalizedVaultRoot}/${vaultRelativePath}`
      : normalizedVaultRoot,
    vaultRelativePath,
    realRoot: normalizedVaultRoot,
  };
}

/**
 * Resolve a path and refuse to follow any symlink inside the vault.
 *
 * String normalization alone is not a boundary: a symlink is invisible to it,
 * so a link inside the vault pointing at ~/.ssh would pass every check and then
 * be read or overwritten. Every filesystem method resolves through here.
 */
export async function resolveVaultPathSafe(
  globalArgs: Record<string, unknown>,
  requestedPath: string,
  options: { allowDotObsidian?: boolean } = {},
): Promise<VaultPath> {
  const logical = resolveVaultPath(globalArgs, requestedPath, options);

  let realRoot: string;
  const rootArg = trimTrailingSlash(globalArgs.vaultRoot as string);
  try {
    realRoot = await Deno.realPath(rootArg);
  } catch {
    throw new Error(
      `vaultRoot does not exist or is not readable: ${rootArg}`,
    );
  }

  const segments = logical.vaultRelativePath
    ? logical.vaultRelativePath.split("/")
    : [];
  let current = realRoot;
  for (const segment of segments) {
    current = `${current}/${segment}`;
    let info: Deno.FileInfo;
    try {
      info = await Deno.lstat(current);
    } catch {
      break; // does not exist yet — nothing to follow
    }
    if (info.isSymlink) {
      throw new Error(
        `Refusing to follow symlink inside the vault: ${
          current.slice(realRoot.length + 1)
        }`,
      );
    }
  }

  return {
    absolutePath: logical.vaultRelativePath
      ? `${realRoot}/${logical.vaultRelativePath}`
      : realRoot,
    vaultRelativePath: logical.vaultRelativePath,
    realRoot,
  };
}

/** Path of Obsidian's own vault registry for the current platform. */
export function obsidianRegistryPath(): string {
  const home = Deno.env.get("HOME") ?? Deno.env.get("USERPROFILE") ?? "";
  if (Deno.build.os === "darwin") {
    return `${home}/Library/Application Support/obsidian/obsidian.json`;
  }
  if (Deno.build.os === "windows") {
    const appData = Deno.env.get("APPDATA") ?? `${home}/AppData/Roaming`;
    return `${appData}/obsidian/obsidian.json`;
  }
  return `${home}/.config/obsidian/obsidian.json`;
}

/**
 * Look up a vault directory by name in Obsidian's registry.
 *
 * The registry is not trustworthy on its own — it keeps pointing at a vault's
 * old location after the directory is moved — so the resolved path is verified
 * before being returned.
 */
export async function resolveVaultRootFromRegistry(
  vaultName: string,
): Promise<string> {
  const registryPath = obsidianRegistryPath();
  let raw: string;
  try {
    raw = await Deno.readTextFile(registryPath);
  } catch {
    throw new Error(
      `vaultRoot is not set and Obsidian's vault registry could not be read at ${registryPath}. Set the vaultRoot global argument explicitly.`,
    );
  }

  let parsed: { vaults?: Record<string, { path?: string }> };
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(
      `Obsidian's vault registry at ${registryPath} is not valid JSON. Set the vaultRoot global argument explicitly.`,
    );
  }

  const entries = Object.values(parsed.vaults ?? {})
    .map((entry) => entry.path)
    .filter((path): path is string => typeof path === "string");
  const matches = entries.filter((path) =>
    trimTrailingSlash(path).split("/").pop() === vaultName
  );

  if (matches.length === 0) {
    throw new Error(
      `No vault named "${vaultName}" in Obsidian's registry at ${registryPath}. Known vaults: ${
        entries.join(", ") || "(none)"
      }. Set the vaultRoot global argument explicitly.`,
    );
  }
  if (matches.length > 1) {
    throw new Error(
      `Vault name "${vaultName}" is ambiguous — the registry at ${registryPath} has more than one vault with that directory name: ${
        matches.join(", ")
      }. Set the vaultRoot global argument explicitly.`,
    );
  }

  const candidate = trimTrailingSlash(matches[0]);
  try {
    const info = await Deno.stat(candidate);
    if (!info.isDirectory) throw new Error("not a directory");
  } catch {
    throw new Error(
      `Obsidian's registry at ${registryPath} maps vault "${vaultName}" to ${candidate}, but that directory does not exist. The vault has most likely been moved. Set the vaultRoot global argument to its current location.`,
    );
  }
  return candidate;
}

/** Global args with vaultRoot filled in from the registry when it was omitted. */
async function withVaultRoot(
  globalArgs: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  if (typeof globalArgs.vaultRoot === "string" && globalArgs.vaultRoot) {
    return globalArgs;
  }
  const vaultName = globalArgs.vault;
  if (typeof vaultName !== "string" || !vaultName) {
    throw new Error(
      "Neither vaultRoot nor vault is set — the filesystem backend cannot locate the vault. Set the vaultRoot global argument.",
    );
  }
  return {
    ...globalArgs,
    vaultRoot: await resolveVaultRootFromRegistry(vaultName),
  };
}

// --- Frontmatter ---------------------------------------------------------

// flowCollectionPadding keeps `[a, b]` from becoming `[ a, b ]`; lineWidth 0
// disables reflowing. Together they make an unmodified round trip
// byte-identical, which is what lets `unchanged` mean anything.
const YAML_OUT = { flowCollectionPadding: false, lineWidth: 0 } as const;

export interface FrontmatterSplit {
  raw: string;
  body: string;
  hasFrontmatter: boolean;
}

/** Split a note into its frontmatter block and body. */
export function splitFrontmatter(content: string): FrontmatterSplit {
  if (!content.startsWith("---\n") && !content.startsWith("---\r\n")) {
    return { raw: "", body: content, hasFrontmatter: false };
  }
  const lines = content.split("\n");
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].replace(/\r$/, "") === "---") {
      return {
        raw: lines.slice(1, i).join("\n") + "\n",
        body: lines.slice(i + 1).join("\n"),
        hasFrontmatter: true,
      };
    }
  }
  return { raw: "", body: content, hasFrontmatter: false };
}

/** Read a note's frontmatter properties, preserving list and scalar types. */
export function readProperties(content: string): Record<string, unknown> {
  const { raw, hasFrontmatter } = splitFrontmatter(content);
  if (!hasFrontmatter) return {};
  const parsed = YAML.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  return parsed as Record<string, unknown>;
}

/**
 * Merge properties into a note's frontmatter and return the new note text.
 *
 * Key order, list style, and comments survive, and a note whose properties are
 * unchanged comes back byte-identical.
 */
export function mergeProperties(
  content: string,
  updates: Record<string, unknown>,
): string {
  const { raw, body, hasFrontmatter } = splitFrontmatter(content);

  if (!hasFrontmatter) {
    if (Object.keys(updates).length === 0) return content;
    const doc = YAML.parseDocument(YAML.stringify(updates, YAML_OUT));
    return `---\n${doc.toString(YAML_OUT)}---\n${content}`;
  }

  const doc = YAML.parseDocument(raw);
  for (const [key, value] of Object.entries(updates)) {
    doc.set(key, value);
  }
  return `---\n${doc.toString(YAML_OUT)}---\n${body}`;
}

/** Remove a frontmatter property and return the new note text. */
export function removeProperty(content: string, name: string): string {
  const { raw, body, hasFrontmatter } = splitFrontmatter(content);
  if (!hasFrontmatter) return content;
  const doc = YAML.parseDocument(raw);
  doc.delete(name);
  return `---\n${doc.toString(YAML_OUT)}---\n${body}`;
}

// --- Write classification ------------------------------------------------

export type WriteAction = "created" | "updated" | "unchanged";

/** Classify a write so callers get a real idempotency signal. */
export function classifyWrite(
  existing: string | null,
  next: string,
): WriteAction {
  if (existing === null) return "created";
  return existing === next ? "unchanged" : "updated";
}

// --- Scan limits -----------------------------------------------------------

// search and digest both walk arbitrary vault content; an unbounded read of a
// single huge file (a pasted log, an export dump) would defeat the point of
// scanning the vault "once" cheaply. Files over this size are skipped rather
// than read, with truncated=true so the caller knows the corpus is partial.
const MAX_SCAN_FILE_BYTES = 2_000_000;
// digest's signalHits array is per-line output meant for a human to skim, not
// a place to accumulate unbounded memory for a vault-wide keyword scan. The
// per-keyword rollup counts and file lists are tracked independently of this
// cap so the reported totals stay true even once the array itself is capped.
const MAX_SIGNAL_HITS = 500;

// --- Search --------------------------------------------------------------

const MAX_PATTERN_LENGTH = 512;
const NESTED_QUANTIFIER = /\([^()]*[+*][^()]*\)\s*[*+]/;
// An alternation whose branches share a prefix (or one contains the other)
// backtracks catastrophically once the group itself is quantified — the
// nested-quantifier guard above only catches a quantifier *inside* the group,
// not this shape.
const ALTERNATION_QUANTIFIER = /\([^()]*\|[^()]*\)\s*[*+]/;

/** Build a line predicate for search, rejecting patterns that could hang. */
export function buildSearchMatcher(
  query: string,
  regex: boolean,
  caseSensitive: boolean,
): (line: string) => boolean {
  if (regex) {
    if (query.length > MAX_PATTERN_LENGTH) {
      throw new Error(
        `Search pattern is too long (${query.length} characters, limit ${MAX_PATTERN_LENGTH}).`,
      );
    }
    if (NESTED_QUANTIFIER.test(query) || ALTERNATION_QUANTIFIER.test(query)) {
      throw new Error(
        `Search pattern rejected: a nested unbounded quantifier can backtrack catastrophically over a large vault. Pattern: ${query}`,
      );
    }
    let compiled: RegExp;
    try {
      compiled = new RegExp(query, caseSensitive ? "" : "i");
    } catch (err) {
      throw new Error(
        `Invalid search regex: ${query} — ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    return (line) => compiled.test(line);
  }
  const needle = caseSensitive ? query : query.toLowerCase();
  return (line) => (caseSensitive ? line : line.toLowerCase()).includes(needle);
}

// --- Digest extractors ---------------------------------------------------

const DATE_RE = /(\d{4})[-,._ ]?(\d{2})[-,._ ]?(\d{2})/;
const PR_RE = /#(\d{3,6})\b|\bPR[-\s]?(\d{3,6})\b/gi;
const TICKET_RE = /\b(?!PR-)([A-Z]{2,10}-\d{1,5})\b/g;
const WIKILINK_RE = /\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]/g;
const INLINE_TAG_RE = /(?:^|\s)#([A-Za-z0-9_][A-Za-z0-9_/-]*)/g;

function uniq(values: string[]): string[] {
  return [...new Set(values)];
}

/** Strip fenced blocks, code spans, and URLs so they cannot yield false tags. */
function stripCodeAndUrls(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`\n]*`/g, " ")
    .replace(/\bhttps?:\/\/\S+/g, " ");
}

/** Markdown headings, levels one through four. */
export function extractHeadings(text: string): string[] {
  return text
    .split("\n")
    .filter((line) => /^#{1,4}\s+\S/.test(line))
    .map((line) => line.replace(/^#{1,4}\s+/, "").trim())
    .slice(0, 40);
}

/** Wikilink targets, with aliases and heading anchors stripped. */
export function extractWikilinks(text: string): string[] {
  return uniq(
    [...text.matchAll(WIKILINK_RE)].map((m) => m[1].trim()),
  ).slice(0, 100);
}

/**
 * Inline #tags, ignoring code spans and URL fragments.
 *
 * Purely numeric matches are dropped: Obsidian requires a tag to contain at
 * least one non-numeric character, so `#1234` is an issue reference, not a tag.
 */
export function extractInlineTags(text: string): string[] {
  return uniq(
    [...stripCodeAndUrls(text).matchAll(INLINE_TAG_RE)]
      .map((m) => m[1])
      .filter((tag) => !/^\d+$/.test(tag)),
  ).slice(0, 100);
}

/** Pull-request references in either #1234 or PR-1234 form. */
export function extractPrRefs(text: string): string[] {
  return uniq(
    [...text.matchAll(PR_RE)].map((m) => `#${m[1] ?? m[2]}`),
  ).slice(0, 50);
}

/** Ticket identifiers such as ABC-42. */
export function extractTicketRefs(text: string): string[] {
  return uniq([...text.matchAll(TICKET_RE)].map((m) => m[1])).slice(0, 50);
}

/** Infer an ISO date from a filename, or null when it carries none. */
export function inferDate(name: string): string | null {
  const m = name.match(DATE_RE);
  if (!m) return null;
  const [, year, month, day] = m;
  const yearNum = Number(year);
  const monthNum = Number(month);
  const dayNum = Number(day);
  if (monthNum < 1 || monthNum > 12 || dayNum < 1 || dayNum > 31) return null;
  // Range checks alone accept impossible dates (e.g. 2026-02-31). Round-trip
  // through UTC and reject anything that rolled over into the next month.
  const date = new Date(Date.UTC(yearNum, monthNum - 1, dayNum));
  if (
    date.getUTCFullYear() !== yearNum ||
    date.getUTCMonth() !== monthNum - 1 ||
    date.getUTCDate() !== dayNum
  ) {
    return null;
  }
  return `${year}-${month}-${day}`;
}

// --- Filesystem helpers --------------------------------------------------

async function chmodQuietly(path: string, mode: number): Promise<void> {
  try {
    await Deno.chmod(path, mode);
  } catch {
    // Some mounted filesystems do not support chmod.
  }
}

async function ensureParentDir(path: string, mode: number): Promise<void> {
  const idx = path.lastIndexOf("/");
  if (idx <= 0) return;
  const parent = path.slice(0, idx);
  await Deno.mkdir(parent, { recursive: true, mode });
}

async function readTextIfExists(path: string): Promise<string | null> {
  try {
    return await Deno.readTextFile(path);
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return null;
    throw err;
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await Deno.lstat(path);
    return true;
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return false;
    throw err;
  }
}

/**
 * Return a path guaranteed not to collide with anything already on disk.
 *
 * A same-named note deleted twice (delete, recreate, delete again) would
 * otherwise have its second .trash rename silently clobber the first —
 * Deno.rename overwrites an existing destination with no warning. Each
 * collision gets a fresh UUID suffix before the extension, re-checked in a
 * loop so even a pathological run of prior collisions cannot produce a
 * second clobber.
 */
async function uniqueTrashPath(path: string): Promise<string> {
  if (!(await pathExists(path))) return path;
  const slash = path.lastIndexOf("/");
  const dot = path.lastIndexOf(".");
  const hasExt = dot > slash;
  const base = hasExt ? path.slice(0, dot) : path;
  const ext = hasExt ? path.slice(dot) : "";
  let candidate: string;
  do {
    candidate = `${base}-${crypto.randomUUID()}${ext}`;
  } while (await pathExists(candidate));
  return candidate;
}

/**
 * Write via a temp file in the same directory, then rename.
 *
 * The vault has lived in a sync folder, where a partial write is visible to the
 * sync client as a truncated note.
 */
async function writeAtomic(
  path: string,
  content: string,
  mode: number,
): Promise<void> {
  const idx = path.lastIndexOf("/");
  const dir = idx > 0 ? path.slice(0, idx) : ".";
  const temp = `${dir}/.swamp-obsidian-${crypto.randomUUID()}.tmp`;

  // Overwriting must not change a note's permissions. defaultFileMode applies
  // to notes this model creates, not to ones the user already owns — a vault
  // holding private archives may deliberately carry tighter modes.
  let effectiveMode = mode;
  try {
    effectiveMode = (await Deno.stat(path)).mode ?? mode;
  } catch {
    // New file — defaultFileMode is correct.
  }

  try {
    await Deno.writeTextFile(temp, content);
    await chmodQuietly(temp, effectiveMode);
    await Deno.rename(temp, path);
  } catch (err) {
    await Deno.remove(temp).catch(() => {});
    throw err;
  }
}

/**
 * Walk markdown files under a directory, skipping hidden directories.
 *
 * Deno.readDir is lazy — it does not throw at the call site, it throws on first
 * iteration. So the guard has to sit around the iteration, and it deliberately
 * only covers recursion: a subdirectory that cannot be read is skipped so one
 * permission problem does not abort a whole-vault digest, while an unreadable
 * root propagates so a typo'd folder is reported rather than silently empty.
 */
async function* walkFiles(
  root: string,
  recursive: boolean,
  includeHidden: boolean,
  isRoot = true,
): AsyncGenerator<string> {
  const entries: Deno.DirEntry[] = [];
  try {
    for await (const entry of Deno.readDir(root)) entries.push(entry);
  } catch (err) {
    if (isRoot) throw err;
    return; // unreadable subdirectory — skip it, keep walking
  }

  // Sort so output ordering is deterministic across runs and `limit` truncates
  // a predictable subset rather than whatever the filesystem happened to yield.
  entries.sort((a, b) => a.name.localeCompare(b.name));

  for (const entry of entries) {
    if (!includeHidden && isHiddenSegment(entry.name)) continue;
    const path = `${root}/${entry.name}`;
    if (entry.isFile) {
      yield path;
    } else if (entry.isDirectory && recursive) {
      yield* walkFiles(path, recursive, includeHidden, false);
    }
  }
}

function relativeFromRoot(root: string, absolutePath: string): string {
  const base = trimTrailingSlash(root);
  return absolutePath.startsWith(`${base}/`)
    ? absolutePath.slice(base.length + 1)
    : absolutePath;
}

function dataName(vaultRelativePath: string): string {
  return vaultRelativePath.replace(/[/\\]/g, "_") || "vault-root";
}

/** Separator precedence: an explicit separator wins; inline is shorthand for "". */
function joinSeparator(
  separator: string | undefined,
  inline: boolean | undefined,
): string {
  if (separator !== undefined) return separator;
  return inline ? "" : "\n";
}

// --- CLI helpers ---------------------------------------------------------

/**
 * Assemble the argv for an Obsidian CLI invocation.
 *
 * Split out from runObsidian so the CLI backend's contract is assertable
 * without a running desktop app — the adapter itself cannot be exercised in CI.
 */
export function buildObsidianArgs(
  command: string,
  params: Record<string, string>,
  vault: string | undefined,
  bareFlags: string[] | undefined = undefined,
): string[] {
  if (!vault) {
    throw new Error(
      `The CLI backend needs the vault global argument (the registered Obsidian vault name) to run "${command}".`,
    );
  }
  const args = [command, `vault=${vault}`];
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) {
      args.push(`${key}=${value}`);
    }
  }
  if (bareFlags) {
    for (const flag of bareFlags) args.push(flag);
  }
  return args;
}

async function runObsidian(
  command: string,
  params: Record<string, string>,
  vault: string | undefined,
  bareFlags: string[] | undefined = undefined,
) {
  const args = buildObsidianArgs(command, params, vault, bareFlags);

  let output: Deno.CommandOutput;
  try {
    output = await new Deno.Command("obsidian", {
      args,
      stdout: "piped",
      stderr: "piped",
    }).output();
  } catch (err) {
    throw new Error(
      `Could not run the "obsidian" binary for "${command}". Install the Obsidian CLI (v1.12+) and put it on PATH, or set vaultRoot to use the headless filesystem backend. Underlying error: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  const stdout = new TextDecoder().decode(output.stdout).trim();
  const stderr = new TextDecoder().decode(output.stderr).trim();

  if (!output.success) {
    const detail = stderr || stdout;
    if (/unable to find obsidian/i.test(detail)) {
      throw new Error(
        `The Obsidian CLI cannot reach the desktop app, which "${command}" needs. Start Obsidian, or set the vaultRoot global argument to use the headless filesystem backend for file operations. Underlying error: ${detail}`,
      );
    }
    throw new Error(
      `obsidian ${command} failed (exit ${output.code}): ${detail}`,
    );
  }
  return stdout;
}

async function runObsidianJson(
  command: string,
  params: Record<string, string>,
  vault: string | undefined,
  bareFlags: string[] | undefined = undefined,
) {
  const stdout = await runObsidian(
    command,
    { ...params, format: "json" },
    vault,
    bareFlags,
  );
  if (!stdout) return null;
  try {
    return JSON.parse(stdout);
  } catch {
    return null;
  }
}

function parseLines(stdout: string): string[] {
  if (!stdout) return [];
  return stdout.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
}

function parseTsv(stdout: string): Record<string, string> {
  if (!stdout) return {};
  const result: Record<string, string> = {};
  for (const line of stdout.split("\n")) {
    const [key, ...rest] = line.split("\t");
    if (key) result[key.trim()] = rest.join("\t").trim();
  }
  return result;
}

function fileParam(file: string): Record<string, string> {
  return file.includes("/") ? { path: file } : { file };
}

const nowIso = () => new Date().toISOString();

/** Obsidian vault model: notes, search, tags, links, daily notes, frontmatter, and a corpus digest, over either the Obsidian CLI or a mounted vault directory. */
export const model = {
  type: "@magistr/obsidian/vault",
  version: "2026.08.02.1",
  upgrades: [
    {
      fromVersion: "2026.03.28.1",
      toVersion: "2026.03.28.2",
      description:
        "Fix CLI output parsing to match actual Obsidian CLI responses",
      upgradeAttributes: (old) => old,
    },
    {
      fromVersion: "2026.03.28.2",
      toVersion: "2026.07.16.2",
      description: "Align model version with the published manifest",
      upgradeAttributes: (old) => old,
    },
    {
      fromVersion: "2026.07.16.2",
      toVersion: "2026.07.27.1",
      description:
        "Add headless filesystem backend, bulk frontmatter merge, and corpus digest",
      upgradeAttributes: (old) => old,
    },
    {
      fromVersion: "2026.07.27.1",
      toVersion: "2026.08.02.1",
      description:
        "Fix eight latent bugs: CRLF-frontmatter data loss, ReDoS alternation guard, backslash traversal, digest/search byte + signalHits bounds, digest backend enforcement, calendar-date validation, trash overwrite, real setProperties/propertyRemove action",
      upgradeAttributes: (old) => old,
    },
  ],
  globalArguments: GlobalArgsSchema,
  resources: {
    note: {
      description: "Single note content and metadata",
      schema: NoteSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    fileInfo: {
      description: "File metadata (existence, size, timestamps)",
      schema: FileInfoSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    notes: {
      description: "List of notes/files in vault",
      schema: NotesSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    searchResults: {
      description: "Search results with matching context",
      schema: SearchResultSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    tags: {
      description: "Tag listing",
      schema: TagsSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    tagFiles: {
      description: "Files matching a specific tag",
      schema: TagFilesSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    links: {
      description: "Links or backlinks for a note",
      schema: LinksSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    unresolved: {
      description: "Unresolved/broken links in vault",
      schema: UnresolvedSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    dailyNote: {
      description: "Daily note content",
      schema: DailyNoteSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    properties: {
      description: "Note frontmatter properties",
      schema: PropertiesSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    operationResult: {
      description: "Result of mutating operations",
      schema: OperationResultSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    corpus: {
      description:
        "Structural digest of the vault: per-note headings, wikilinks, tags, refs and word counts, plus signal-keyword rollups",
      schema: CorpusSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  methods: {
    // --- File Operations ---

    list: {
      description:
        "List notes in the vault (filesystem backend when vaultRoot is set)",
      arguments: z.object({
        folder: z.string().optional().describe("Filter by folder path"),
        ext: z.string().optional().describe("Filter by extension (e.g. 'md')"),
        recursive: z.boolean().optional().describe(
          "Descend into subfolders (filesystem backend; default true)",
        ),
        limit: z.number().optional().describe("Maximum files to return"),
        allowDotObsidian: z.boolean().optional().describe(
          "Permit traversal of .obsidian and other hidden directories",
        ),
      }),
      execute: async (args, context) => {
        const backend = selectBackend(context.globalArgs, "list");
        const limit = args.limit ?? 0;
        let files: string[] = [];
        let truncated = false;

        if (backend === "fs") {
          const globalArgs = await withVaultRoot(context.globalArgs);
          const root = await resolveVaultPathSafe(
            globalArgs,
            args.folder ?? "",
            { allowDotObsidian: args.allowDotObsidian },
          );
          context.logger?.info?.("Listing vault folder {folder}", {
            folder: root.vaultRelativePath || "(root)",
          });
          const suffix = args.ext ? `.${args.ext.replace(/^\./, "")}` : "";
          const vaultRoot = root.realRoot;
          for await (
            const path of walkFiles(
              root.absolutePath,
              args.recursive ?? true,
              args.allowDotObsidian ?? false,
            )
          ) {
            if (suffix && !path.endsWith(suffix)) continue;
            files.push(relativeFromRoot(vaultRoot, path));
            if (limit > 0 && files.length >= limit) {
              truncated = true;
              break;
            }
          }
        } else {
          const params: Record<string, string> = {};
          if (args.folder) params.folder = args.folder;
          if (args.ext) params.ext = args.ext;
          const stdout = await runObsidian(
            "files",
            params,
            context.globalArgs.vault,
          );
          files = parseLines(stdout);
          if (args.recursive === false) {
            const prefix = args.folder
              ? `${trimTrailingSlash(args.folder)}/`
              : "";
            files = files.filter((f) =>
              f.startsWith(prefix) && !f.slice(prefix.length).includes("/")
            );
          }
          if (limit > 0 && files.length > limit) {
            files = files.slice(0, limit);
            truncated = true;
          }
        }

        files.sort((a, b) => a.localeCompare(b));
        context.logger?.info?.("Listed {count} files", { count: files.length });
        const handle = await context.writeResource("notes", "main", {
          files,
          count: files.length,
          truncated,
          timestamp: nowIso(),
        });
        return { dataHandles: [handle] };
      },
    },

    read: {
      description: "Read a note's content",
      arguments: z.object({
        file: z.string().describe("Path to note (e.g. 'folder/note.md')"),
        allowDotObsidian: z.boolean().optional().describe(
          "Permit reading inside .obsidian",
        ),
      }),
      execute: async (args, context) => {
        const backend = selectBackend(context.globalArgs, "read");
        let content: string;
        if (backend === "fs") {
          const globalArgs = await withVaultRoot(context.globalArgs);
          const target = await resolveVaultPathSafe(globalArgs, args.file, {
            allowDotObsidian: args.allowDotObsidian,
          });
          context.logger?.info?.("Reading note {file}", { file: args.file });
          content = await Deno.readTextFile(target.absolutePath);
        } else {
          content = await runObsidian(
            "read",
            fileParam(args.file),
            context.globalArgs.vault,
          );
        }
        const handle = await context.writeResource(
          "note",
          dataName(args.file),
          { file: args.file, content, timestamp: nowIso() },
        );
        return { dataHandles: [handle] };
      },
    },

    fileInfo: {
      description:
        "Show file metadata. Reports exists=false rather than failing when the note is absent.",
      arguments: z.object({
        file: z.string().describe("Path to note"),
        allowDotObsidian: z.boolean().optional(),
      }),
      execute: async (args, context) => {
        const backend = selectBackend(context.globalArgs, "fileInfo");
        let payload: Record<string, unknown>;

        if (backend === "fs") {
          const globalArgs = await withVaultRoot(context.globalArgs);
          const target = await resolveVaultPathSafe(globalArgs, args.file, {
            allowDotObsidian: args.allowDotObsidian,
          });
          const name = target.vaultRelativePath.split("/").pop() ?? "";
          const dot = name.lastIndexOf(".");
          try {
            const stat = await Deno.stat(target.absolutePath);
            payload = {
              path: target.vaultRelativePath,
              name,
              extension: dot > 0 ? name.slice(dot + 1) : "",
              size: stat.size,
              created: stat.birthtime ? stat.birthtime.getTime() : 0,
              modified: stat.mtime ? stat.mtime.getTime() : 0,
              exists: true,
              modifiedAt: stat.mtime?.toISOString(),
              timestamp: nowIso(),
            };
          } catch (err) {
            if (!(err instanceof Deno.errors.NotFound)) throw err;
            payload = {
              path: target.vaultRelativePath,
              name,
              exists: false,
              timestamp: nowIso(),
            };
          }
        } else {
          const stdout = await runObsidian(
            "file",
            fileParam(args.file),
            context.globalArgs.vault,
          );
          const info = parseTsv(stdout);
          payload = {
            path: info.path || args.file,
            name: info.name || "",
            extension: info.extension || "",
            size: Number(info.size) || 0,
            created: Number(info.created) || 0,
            modified: Number(info.modified) || 0,
            exists: true,
            timestamp: nowIso(),
          };
        }

        const handle = await context.writeResource(
          "fileInfo",
          dataName(args.file),
          payload,
        );
        return { dataHandles: [handle] };
      },
    },

    create: {
      description:
        "Create or replace a note. Reports created, updated, or unchanged; an unchanged note is not rewritten.",
      arguments: z.object({
        name: z.string().describe(
          "Path for the note (e.g. 'folder/note.md' or 'note')",
        ),
        content: z.string().optional().describe("Note content"),
        template: z.string().optional().describe(
          "Template name to use (CLI backend only)",
        ),
        overwrite: z.boolean().optional().describe("Overwrite if file exists"),
        allowDotObsidian: z.boolean().optional(),
      }),
      execute: async (args, context) => {
        const backend = selectBackend(context.globalArgs, "create");
        const content = args.content ?? "";
        let action: WriteAction;

        if (backend === "fs") {
          if (args.template) {
            throw new Error(
              "The template argument needs Obsidian's template engine and is not available on the filesystem backend. Use backend=cli with the desktop app running, or pass the rendered content directly.",
            );
          }
          const globalArgs = await withVaultRoot(context.globalArgs);
          const target = await resolveVaultPathSafe(globalArgs, args.name, {
            allowDotObsidian: args.allowDotObsidian,
          });
          const existing = await readTextIfExists(target.absolutePath);
          if (existing !== null && !args.overwrite) {
            throw new Error(
              `Refusing to overwrite an existing note without overwrite=true: ${target.vaultRelativePath}`,
            );
          }
          action = classifyWrite(existing, content);
          if (action !== "unchanged") {
            await ensureParentDir(
              target.absolutePath,
              globalArgs.defaultDirectoryMode as number,
            );
            await writeAtomic(
              target.absolutePath,
              content,
              globalArgs.defaultFileMode as number,
            );
          }
          context.logger?.info?.("Note {file} {action}", {
            file: target.vaultRelativePath,
            action,
          });
        } else {
          let existing: string | null = null;
          if (!args.template) {
            try {
              existing = await runObsidian(
                "read",
                fileParam(args.name),
                context.globalArgs.vault,
              );
            } catch {
              existing = null;
            }
          }
          action = args.template ? "created" : classifyWrite(existing, content);
          if (action !== "unchanged") {
            const nameKey = args.name.includes("/") ? "path" : "name";
            const params: Record<string, string> = { [nameKey]: args.name };
            if (args.content) params.content = args.content;
            if (args.template) params.template = args.template;
            await runObsidian(
              "create",
              params,
              context.globalArgs.vault,
              args.overwrite ? ["overwrite"] : undefined,
            );
          }
        }

        const handle = await context.writeResource(
          "operationResult",
          "create",
          {
            operation: "create",
            file: args.name,
            success: true,
            action,
            bytes: new TextEncoder().encode(content).byteLength,
            timestamp: nowIso(),
          },
        );
        return { dataHandles: [handle] };
      },
    },

    append: {
      description: "Append content to the end of a note",
      arguments: z.object({
        file: z.string().describe("Path to note"),
        content: z.string().describe("Content to append"),
        separator: z.string().optional().describe(
          "Text inserted between the existing content and the new content. Wins over inline; defaults to a newline.",
        ),
        inline: z.boolean().optional().describe(
          'Shorthand for separator="" (append with no separator)',
        ),
        allowDotObsidian: z.boolean().optional(),
      }),
      execute: async (args, context) => {
        const backend = selectBackend(context.globalArgs, "append");
        const separator = joinSeparator(args.separator, args.inline);

        if (backend === "fs") {
          const globalArgs = await withVaultRoot(context.globalArgs);
          const target = await resolveVaultPathSafe(globalArgs, args.file, {
            allowDotObsidian: args.allowDotObsidian,
          });
          const existing = await readTextIfExists(target.absolutePath);
          const next = existing === null || existing.length === 0
            ? args.content
            : `${existing}${separator}${args.content}`;
          await ensureParentDir(
            target.absolutePath,
            globalArgs.defaultDirectoryMode as number,
          );
          await writeAtomic(
            target.absolutePath,
            next,
            globalArgs.defaultFileMode as number,
          );
          context.logger?.info?.("Appended to {file}", {
            file: target.vaultRelativePath,
          });
        } else {
          await runObsidian(
            "append",
            { ...fileParam(args.file), content: `${separator}${args.content}` },
            context.globalArgs.vault,
            ["inline"],
          );
        }

        const handle = await context.writeResource(
          "operationResult",
          "append",
          {
            operation: "append",
            file: args.file,
            success: true,
            action: "appended",
            bytes: new TextEncoder().encode(args.content).byteLength,
            timestamp: nowIso(),
          },
        );
        return { dataHandles: [handle] };
      },
    },

    prepend: {
      description: "Prepend content after the frontmatter",
      arguments: z.object({
        file: z.string().describe("Path to note"),
        content: z.string().describe("Content to prepend"),
        separator: z.string().optional().describe(
          "Text inserted between the new content and the existing content. Wins over inline; defaults to a newline.",
        ),
        inline: z.boolean().optional().describe(
          'Shorthand for separator="" (prepend with no separator)',
        ),
        allowDotObsidian: z.boolean().optional(),
      }),
      execute: async (args, context) => {
        const backend = selectBackend(context.globalArgs, "prepend");
        const separator = joinSeparator(args.separator, args.inline);

        if (backend === "fs") {
          const globalArgs = await withVaultRoot(context.globalArgs);
          const target = await resolveVaultPathSafe(globalArgs, args.file, {
            allowDotObsidian: args.allowDotObsidian,
          });
          const existing = await readTextIfExists(target.absolutePath) ?? "";
          const { raw, body, hasFrontmatter } = splitFrontmatter(existing);
          const nextBody = body.length === 0
            ? args.content
            : `${args.content}${separator}${body}`;
          const next = hasFrontmatter
            ? `---\n${raw}---\n${nextBody}`
            : nextBody;
          await ensureParentDir(
            target.absolutePath,
            globalArgs.defaultDirectoryMode as number,
          );
          await writeAtomic(
            target.absolutePath,
            next,
            globalArgs.defaultFileMode as number,
          );
          context.logger?.info?.("Prepended to {file}", {
            file: target.vaultRelativePath,
          });
        } else {
          await runObsidian(
            "prepend",
            { ...fileParam(args.file), content: `${args.content}${separator}` },
            context.globalArgs.vault,
            ["inline"],
          );
        }

        const handle = await context.writeResource(
          "operationResult",
          "prepend",
          {
            operation: "prepend",
            file: args.file,
            success: true,
            action: "updated",
            timestamp: nowIso(),
          },
        );
        return { dataHandles: [handle] };
      },
    },

    delete: {
      description:
        "Delete a note. Moves it to the vault's .trash by default on both backends.",
      arguments: z.object({
        file: z.string().describe("Path to note"),
        permanent: z.boolean().optional().describe(
          "Permanently delete instead of moving to trash",
        ),
        dryRun: z.boolean().optional().describe(
          "Report what would be removed without removing it",
        ),
        allowDotObsidian: z.boolean().optional(),
      }),
      execute: async (args, context) => {
        const backend = selectBackend(context.globalArgs, "delete");

        if (args.dryRun) {
          let resolved = args.file;
          if (backend === "fs") {
            const globalArgs = await withVaultRoot(context.globalArgs);
            const target = await resolveVaultPathSafe(globalArgs, args.file, {
              allowDotObsidian: args.allowDotObsidian,
            });
            resolved = target.absolutePath;
          }
          const handle = await context.writeResource(
            "operationResult",
            "delete",
            {
              operation: "delete-dry-run",
              file: args.file,
              success: true,
              message: `Would ${
                args.permanent ? "permanently delete" : "move to .trash"
              }: ${resolved}`,
              timestamp: nowIso(),
            },
          );
          return { dataHandles: [handle] };
        }

        if (backend === "fs") {
          const globalArgs = await withVaultRoot(context.globalArgs);
          const target = await resolveVaultPathSafe(globalArgs, args.file, {
            allowDotObsidian: args.allowDotObsidian,
          });
          const vaultRoot = target.realRoot;
          if (args.permanent) {
            await Deno.remove(target.absolutePath);
          } else {
            const trashPath = `${vaultRoot}/.trash/${target.vaultRelativePath}`;
            await ensureParentDir(
              trashPath,
              globalArgs.defaultDirectoryMode as number,
            );
            const finalTrashPath = await uniqueTrashPath(trashPath);
            await Deno.rename(target.absolutePath, finalTrashPath);
          }
          context.logger?.info?.("Deleted {file}", {
            file: target.vaultRelativePath,
            permanent: args.permanent ?? false,
          });
        } else {
          await runObsidian(
            "delete",
            fileParam(args.file),
            context.globalArgs.vault,
            args.permanent ? ["permanent"] : undefined,
          );
        }

        const handle = await context.writeResource(
          "operationResult",
          "delete",
          {
            operation: args.permanent ? "delete-permanent" : "delete",
            file: args.file,
            success: true,
            action: "removed",
            timestamp: nowIso(),
          },
        );
        return { dataHandles: [handle] };
      },
    },

    move: {
      description:
        "Move or rename a note, rewriting wikilinks (needs the Obsidian CLI)",
      arguments: z.object({
        file: z.string().describe("Current path"),
        to: z.string().describe("Destination folder or path"),
      }),
      execute: async (args, context) => {
        selectBackend(context.globalArgs, "move");
        await runObsidian(
          "move",
          { ...fileParam(args.file), to: args.to },
          context.globalArgs.vault,
        );
        const handle = await context.writeResource("operationResult", "move", {
          operation: "move",
          file: `${args.file} -> ${args.to}`,
          success: true,
          timestamp: nowIso(),
        });
        return { dataHandles: [handle] };
      },
    },

    // --- Search ---

    search: {
      description: "Full-text search with matching line context",
      arguments: z.object({
        query: z.string().describe("Search query"),
        folder: z.string().optional().describe("Limit to folder"),
        path: z.string().optional().describe("Alias for folder"),
        regex: z.boolean().optional().describe(
          "Treat the query as a regular expression (filesystem backend only)",
        ),
        caseSensitive: z.boolean().optional().describe(
          "Match case exactly (filesystem backend only)",
        ),
        limit: z.number().optional().describe("Max matches to return"),
        allowDotObsidian: z.boolean().optional(),
      }),
      execute: async (args, context) => {
        const backend = selectBackend(context.globalArgs, "search");
        const folder = args.folder ?? args.path ?? "";
        const limit = args.limit ?? 200;
        const grouped = new Map<string, { line: number; text: string }[]>();
        let truncated = false;

        if (backend === "fs") {
          const globalArgs = await withVaultRoot(context.globalArgs);
          const root = await resolveVaultPathSafe(globalArgs, folder, {
            allowDotObsidian: args.allowDotObsidian,
          });
          const matcher = buildSearchMatcher(
            args.query,
            args.regex ?? false,
            args.caseSensitive ?? false,
          );
          context.logger?.info?.("Searching {folder}", {
            folder: root.vaultRelativePath || "(root)",
          });
          const vaultRoot = root.realRoot;
          const deadline = Date.now() + 60_000;
          let total = 0;
          outer: for await (
            const path of walkFiles(
              root.absolutePath,
              true,
              args.allowDotObsidian ?? false,
            )
          ) {
            if (!path.endsWith(".md")) continue;
            if (Date.now() > deadline) {
              truncated = true;
              break;
            }
            const stat = await Deno.stat(path);
            if (stat.size > MAX_SCAN_FILE_BYTES) {
              truncated = true;
              continue;
            }
            const text = await Deno.readTextFile(path);
            const lines = text.split(/\r?\n/);
            const relative = relativeFromRoot(vaultRoot, path);
            for (let i = 0; i < lines.length; i++) {
              if (!matcher(lines[i])) continue;
              const bucket = grouped.get(relative) ?? [];
              bucket.push({ line: i + 1, text: lines[i] });
              grouped.set(relative, bucket);
              if (++total >= limit) {
                truncated = true;
                break outer;
              }
            }
          }
        } else {
          if (args.regex) {
            throw new Error(
              "regex search needs the filesystem backend — the Obsidian CLI has no regex mode. Set vaultRoot, or drop regex=true.",
            );
          }
          const params: Record<string, string> = { query: args.query };
          if (folder) params.path = folder;
          if (args.limit) params.limit = String(args.limit);
          const data = await runObsidianJson(
            "search:context",
            params,
            context.globalArgs.vault,
          );
          for (const entry of Array.isArray(data) ? data : []) {
            grouped.set(
              entry.file || "",
              Array.isArray(entry.matches) ? entry.matches : [],
            );
          }
        }

        const results = [...grouped.entries()]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([file, matches]) => ({ file, matches }));
        context.logger?.info?.("Search matched {count} files", {
          count: results.length,
        });
        const handle = await context.writeResource("searchResults", "main", {
          query: args.query,
          results,
          count: results.length,
          truncated,
          timestamp: nowIso(),
        });
        return { dataHandles: [handle] };
      },
    },

    digest: {
      description:
        "Scan the vault once and produce a queryable structural digest — headings, wikilinks, tags, refs, word counts, and signal-keyword rollups",
      arguments: z.object({
        folder: z.string().optional().describe("Limit the scan to a folder"),
        datePrefixes: z.array(z.string()).optional().describe(
          "Only include files whose name starts with one of these prefixes",
        ),
        nameContains: z.array(z.string()).optional().describe(
          "Only include files whose name contains one of these substrings",
        ),
        signalKeywords: z.array(z.string()).optional().describe(
          "Keywords to count across note bodies, each hit recorded with its line",
        ),
        maxFiles: z.number().default(2000).describe(
          "Stop after this many files and report truncated=true",
        ),
        maxBodyChars: z.number().default(0).describe(
          "Characters of body text to retain per note. Defaults to 0 — raising it copies note content into the swamp datastore.",
        ),
        allowDotObsidian: z.boolean().optional(),
      }),
      execute: async (args, context) => {
        const backend = selectBackend(context.globalArgs, "digest");
        if (backend === "cli") {
          throw new Error(
            "digest runs only on the filesystem backend — it needs vaultRoot, not the Obsidian index. Use backend=auto or fs.",
          );
        }
        const globalArgs = await withVaultRoot(context.globalArgs);
        const root = await resolveVaultPathSafe(globalArgs, args.folder ?? "", {
          allowDotObsidian: args.allowDotObsidian,
        });
        const vaultRoot = root.realRoot;
        const datePrefixes = args.datePrefixes ?? [];
        const nameContains = args.nameContains ?? [];
        const keywords = args.signalKeywords ?? [];
        const keywordsLower = keywords.map((k) => k.toLowerCase());

        const matchName = (baseName: string): boolean => {
          if (datePrefixes.length === 0 && nameContains.length === 0) {
            return true;
          }
          const lower = baseName.toLowerCase();
          if (nameContains.some((s) => lower.includes(s.toLowerCase()))) {
            return true;
          }
          return datePrefixes.some((p) => baseName.startsWith(p));
        };

        context.logger?.info?.("Digesting vault folder {folder}", {
          folder: root.vaultRelativePath || "(root)",
        });

        const files: Record<string, unknown>[] = [];
        const signalHits: { keyword: string; file: string; line: string }[] =
          [];
        // Tracked independently of signalHits so the reported count/files
        // stay TRUE totals even after the output array itself is capped.
        const keywordCounts = new Map<string, number>();
        const keywordFiles = new Map<string, Set<string>>();
        let truncated = false;
        let totalWords = 0;

        for await (
          const path of walkFiles(
            root.absolutePath,
            true,
            args.allowDotObsidian ?? false,
          )
        ) {
          if (!path.endsWith(".md")) continue;
          const baseName = path.split("/").pop() ?? "";
          if (!matchName(baseName)) continue;
          if (files.length >= args.maxFiles) {
            truncated = true;
            break;
          }

          const stat = await Deno.stat(path);
          if (stat.size > MAX_SCAN_FILE_BYTES) {
            truncated = true;
            continue;
          }

          const text = await Deno.readTextFile(path);
          const relative = relativeFromRoot(vaultRoot, path);
          const words = text.split(/\s+/).filter(Boolean).length;
          totalWords += words;

          if (keywordsLower.length > 0) {
            for (const line of text.split("\n")) {
              const lower = line.toLowerCase();
              for (let i = 0; i < keywordsLower.length; i++) {
                if (lower.includes(keywordsLower[i])) {
                  const keyword = keywords[i];
                  keywordCounts.set(
                    keyword,
                    (keywordCounts.get(keyword) ?? 0) + 1,
                  );
                  let fileSet = keywordFiles.get(keyword);
                  if (!fileSet) {
                    fileSet = new Set<string>();
                    keywordFiles.set(keyword, fileSet);
                  }
                  fileSet.add(relative);
                  if (signalHits.length < MAX_SIGNAL_HITS) {
                    signalHits.push({
                      keyword,
                      file: relative,
                      line: line.trim().slice(0, 240),
                    });
                  } else {
                    truncated = true;
                  }
                }
              }
            }
          }

          const entry: Record<string, unknown> = {
            file: relative,
            inferredDate: inferDate(baseName),
            headings: extractHeadings(text),
            wikilinks: extractWikilinks(text),
            tags: extractInlineTags(text),
            prRefs: extractPrRefs(text),
            ticketRefs: extractTicketRefs(text),
            wordCount: words,
          };
          if (args.maxBodyChars > 0) {
            entry.body = text.slice(0, args.maxBodyChars);
          }
          files.push(entry);

          if (files.length % 250 === 0) {
            context.logger?.info?.("Digested {count} notes so far", {
              count: files.length,
            });
          }
        }

        files.sort((a, b) =>
          String(a.inferredDate ?? a.file).localeCompare(
            String(b.inferredDate ?? b.file),
          )
        );
        const dates = files
          .map((f) => f.inferredDate)
          .filter((d): d is string => typeof d === "string")
          .sort();
        const rollups = keywords.map((keyword) => ({
          keyword,
          count: keywordCounts.get(keyword) ?? 0,
          files: [...(keywordFiles.get(keyword) ?? [])].slice(0, 50),
        })).sort((a, b) => b.count - a.count);

        context.logger?.info?.(
          "Digest complete: {count} notes, {words} words, truncated={truncated}",
          { count: files.length, words: totalWords, truncated },
        );

        const handle = await context.writeResource("corpus", "current", {
          folder: root.vaultRelativePath,
          generatedAt: nowIso(),
          fileCount: files.length,
          totalWords,
          truncated,
          dateRange: {
            earliest: dates[0] ?? null,
            latest: dates[dates.length - 1] ?? null,
          },
          signalRollups: rollups,
          signalHits,
          files,
        });
        return { dataHandles: [handle] };
      },
    },

    // --- Tags ---

    tags: {
      description: "List all tags in the vault (needs the Obsidian CLI)",
      arguments: z.object({
        counts: z.boolean().optional().describe("Include occurrence counts"),
      }),
      execute: async (args, context) => {
        selectBackend(context.globalArgs, "tags");
        const data = await runObsidianJson(
          "tags",
          {},
          context.globalArgs.vault,
          args.counts ? ["counts"] : undefined,
        );
        const tags = Array.isArray(data)
          ? data.map((t) => ({
            tag: typeof t === "string" ? t : (t.tag || ""),
            count: t.count,
          }))
          : [];
        const handle = await context.writeResource("tags", "main", {
          tags,
          count: tags.length,
          timestamp: nowIso(),
        });
        return { dataHandles: [handle] };
      },
    },

    tag: {
      description: "List files with a specific tag (needs the Obsidian CLI)",
      arguments: z.object({
        name: z.string().describe("Tag name (e.g. '#swamp' or 'swamp')"),
      }),
      execute: async (args, context) => {
        selectBackend(context.globalArgs, "tag");
        const tagName = args.name.startsWith("#") ? args.name : `#${args.name}`;
        const stdout = await runObsidian(
          "tag",
          { name: tagName },
          context.globalArgs.vault,
        );
        const files = parseLines(stdout);
        const handle = await context.writeResource(
          "tagFiles",
          tagName.replace(/^#/, ""),
          {
            tag: tagName,
            files,
            count: files.length,
            timestamp: nowIso(),
          },
        );
        return { dataHandles: [handle] };
      },
    },

    // --- Links ---

    links: {
      description: "Show outgoing links from a note (needs the Obsidian CLI)",
      arguments: z.object({
        file: z.string().describe("Path to note"),
      }),
      execute: async (args, context) => {
        selectBackend(context.globalArgs, "links");
        const stdout = await runObsidian(
          "links",
          fileParam(args.file),
          context.globalArgs.vault,
        );
        const links = stdout.startsWith("No links") ? [] : parseLines(stdout);
        const handle = await context.writeResource("links", "outgoing", {
          file: args.file,
          direction: "outgoing",
          links,
          count: links.length,
          timestamp: nowIso(),
        });
        return { dataHandles: [handle] };
      },
    },

    backlinks: {
      description: "Show files linking to a note (needs the Obsidian CLI)",
      arguments: z.object({
        file: z.string().describe("Path to note"),
      }),
      execute: async (args, context) => {
        selectBackend(context.globalArgs, "backlinks");
        const data = await runObsidianJson(
          "backlinks",
          fileParam(args.file),
          context.globalArgs.vault,
        );
        let links;
        if (Array.isArray(data)) {
          links = data.map((l) =>
            typeof l === "string" ? l : (l.file || l.path || "")
          );
        } else {
          const stdout = await runObsidian(
            "backlinks",
            fileParam(args.file),
            context.globalArgs.vault,
          );
          links = stdout.startsWith("No backlinks") ? [] : parseLines(stdout);
        }
        const handle = await context.writeResource("links", "incoming", {
          file: args.file,
          direction: "incoming",
          links,
          count: links.length,
          timestamp: nowIso(),
        });
        return { dataHandles: [handle] };
      },
    },

    orphans: {
      description: "List notes with no incoming links (needs the Obsidian CLI)",
      arguments: z.object({}),
      execute: async (_args, context) => {
        selectBackend(context.globalArgs, "orphans");
        const stdout = await runObsidian(
          "orphans",
          {},
          context.globalArgs.vault,
        );
        const files = parseLines(stdout);
        const handle = await context.writeResource("notes", "orphans", {
          files,
          count: files.length,
          truncated: false,
          timestamp: nowIso(),
        });
        return { dataHandles: [handle] };
      },
    },

    unresolved: {
      description:
        "List unresolved/broken links in the vault (needs the Obsidian CLI)",
      arguments: z.object({
        verbose: z.boolean().optional().describe("Include source files"),
      }),
      execute: async (args, context) => {
        selectBackend(context.globalArgs, "unresolved");
        const data = await runObsidianJson(
          "unresolved",
          {},
          context.globalArgs.vault,
          args.verbose ? ["verbose"] : undefined,
        );
        const links = Array.isArray(data)
          ? data.map((l) => ({
            link: typeof l === "string" ? l : (l.link || ""),
            count: l.count,
          }))
          : [];
        const handle = await context.writeResource("unresolved", "main", {
          links,
          count: links.length,
          timestamp: nowIso(),
        });
        return { dataHandles: [handle] };
      },
    },

    // --- Daily Notes ---

    daily: {
      description: "Open or create today's daily note (needs the Obsidian CLI)",
      arguments: z.object({}),
      execute: async (_args, context) => {
        selectBackend(context.globalArgs, "daily");
        await runObsidian("daily", {}, context.globalArgs.vault);
        const handle = await context.writeResource("operationResult", "daily", {
          operation: "daily",
          success: true,
          message: "Daily note opened/created",
          timestamp: nowIso(),
        });
        return { dataHandles: [handle] };
      },
    },

    dailyRead: {
      description: "Read today's daily note content (needs the Obsidian CLI)",
      arguments: z.object({}),
      execute: async (_args, context) => {
        selectBackend(context.globalArgs, "dailyRead");
        const content = await runObsidian(
          "daily:read",
          {},
          context.globalArgs.vault,
        );
        const path = await runObsidian(
          "daily:path",
          {},
          context.globalArgs.vault,
        );
        const handle = await context.writeResource("dailyNote", "today", {
          content,
          path: path || undefined,
          timestamp: nowIso(),
        });
        return { dataHandles: [handle] };
      },
    },

    dailyAppend: {
      description:
        "Append content to today's daily note (needs the Obsidian CLI)",
      arguments: z.object({
        content: z.string().describe("Content to append"),
        separator: z.string().optional().describe(
          "Text inserted before the new content. Wins over inline; defaults to a newline.",
        ),
        inline: z.boolean().optional().describe('Shorthand for separator=""'),
      }),
      execute: async (args, context) => {
        selectBackend(context.globalArgs, "dailyAppend");
        const separator = joinSeparator(args.separator, args.inline);
        await runObsidian(
          "daily:append",
          { content: `${separator}${args.content}` },
          context.globalArgs.vault,
          ["inline"],
        );
        const handle = await context.writeResource(
          "operationResult",
          "dailyAppend",
          {
            operation: "daily:append",
            success: true,
            action: "appended",
            timestamp: nowIso(),
          },
        );
        return { dataHandles: [handle] };
      },
    },

    dailyPrepend: {
      description:
        "Prepend content to today's daily note (needs the Obsidian CLI)",
      arguments: z.object({
        content: z.string().describe("Content to prepend"),
        separator: z.string().optional().describe(
          "Text inserted after the new content. Wins over inline; defaults to a newline.",
        ),
        inline: z.boolean().optional().describe('Shorthand for separator=""'),
      }),
      execute: async (args, context) => {
        selectBackend(context.globalArgs, "dailyPrepend");
        const separator = joinSeparator(args.separator, args.inline);
        await runObsidian(
          "daily:prepend",
          { content: `${args.content}${separator}` },
          context.globalArgs.vault,
          ["inline"],
        );
        const handle = await context.writeResource(
          "operationResult",
          "dailyPrepend",
          {
            operation: "daily:prepend",
            success: true,
            action: "updated",
            timestamp: nowIso(),
          },
        );
        return { dataHandles: [handle] };
      },
    },

    // --- Properties (Frontmatter) ---

    properties: {
      description: "Read frontmatter properties of a note",
      arguments: z.object({
        file: z.string().describe("Path to note"),
        allowDotObsidian: z.boolean().optional(),
      }),
      execute: async (args, context) => {
        const backend = selectBackend(context.globalArgs, "properties");
        let properties: Record<string, unknown>;

        if (backend === "fs") {
          const globalArgs = await withVaultRoot(context.globalArgs);
          const target = await resolveVaultPathSafe(globalArgs, args.file, {
            allowDotObsidian: args.allowDotObsidian,
          });
          properties = readProperties(
            await Deno.readTextFile(target.absolutePath),
          );
        } else {
          properties = await runObsidianJson(
            "properties",
            fileParam(args.file),
            context.globalArgs.vault,
          ) || {};
        }

        const handle = await context.writeResource(
          "properties",
          dataName(args.file),
          { file: args.file, properties, timestamp: nowIso() },
        );
        return { dataHandles: [handle] };
      },
    },

    propertySet: {
      description: "Set a single frontmatter property on a note",
      arguments: z.object({
        file: z.string().describe("Path to note"),
        name: z.string().describe("Property name"),
        value: z.string().describe(
          'Property value (use a JSON array for list types, e.g. \'["a","b"]\')',
        ),
        type: z.enum(["text", "list", "number", "checkbox", "date", "datetime"])
          .optional()
          .describe("Property type hint"),
        allowDotObsidian: z.boolean().optional(),
      }),
      execute: async (args, context) => {
        const backend = selectBackend(context.globalArgs, "propertySet");

        if (backend === "fs") {
          const globalArgs = await withVaultRoot(context.globalArgs);
          const target = await resolveVaultPathSafe(globalArgs, args.file, {
            allowDotObsidian: args.allowDotObsidian,
          });
          const existing = await readTextIfExists(target.absolutePath) ?? "";
          const value = coerceProperty(args.value, args.type);
          const next = mergeProperties(existing, { [args.name]: value });
          await ensureParentDir(
            target.absolutePath,
            globalArgs.defaultDirectoryMode as number,
          );
          await writeAtomic(
            target.absolutePath,
            next,
            globalArgs.defaultFileMode as number,
          );
        } else {
          const params: Record<string, string> = {
            ...fileParam(args.file),
            name: args.name,
            value: args.value,
          };
          if (args.type) params.type = args.type;
          await runObsidian("property:set", params, context.globalArgs.vault);
        }

        const handle = await context.writeResource(
          "operationResult",
          "propertySet",
          {
            operation: "property:set",
            file: args.file,
            success: true,
            action: "updated",
            message: `Set ${args.name}`,
            timestamp: nowIso(),
          },
        );
        return { dataHandles: [handle] };
      },
    },

    setProperties: {
      description:
        "Merge several frontmatter properties into a note in one call",
      arguments: z.object({
        file: z.string().describe("Path to note"),
        properties: z.record(z.string(), z.unknown()).describe(
          "Property map to merge. Values may be strings, numbers, booleans, null, or arrays.",
        ),
        allowDotObsidian: z.boolean().optional(),
      }),
      execute: async (args, context) => {
        const backend = selectBackend(context.globalArgs, "setProperties");
        const entries = Object.entries(args.properties);
        let action: WriteAction = "updated";

        if (backend === "fs") {
          const globalArgs = await withVaultRoot(context.globalArgs);
          const target = await resolveVaultPathSafe(globalArgs, args.file, {
            allowDotObsidian: args.allowDotObsidian,
          });
          const existing = await readTextIfExists(target.absolutePath) ?? "";
          const next = mergeProperties(existing, args.properties);
          action = classifyWrite(
            existing.length ? existing : null,
            next,
          );
          if (action !== "unchanged") {
            await ensureParentDir(
              target.absolutePath,
              globalArgs.defaultDirectoryMode as number,
            );
            await writeAtomic(
              target.absolutePath,
              next,
              globalArgs.defaultFileMode as number,
            );
          }
          context.logger?.info?.("Set {count} properties on {file}", {
            count: entries.length,
            file: target.vaultRelativePath,
          });
        } else {
          // Fan out inside one method run so the model lock is taken once.
          for (const [name, value] of entries) {
            await runObsidian("property:set", {
              ...fileParam(args.file),
              name,
              value: Array.isArray(value)
                ? JSON.stringify(value)
                : String(value),
              ...(propertyTypeHint(value)
                ? { type: propertyTypeHint(value)! }
                : {}),
            }, context.globalArgs.vault);
          }
        }

        const handle = await context.writeResource(
          "operationResult",
          "setProperties",
          {
            operation: "setProperties",
            file: args.file,
            success: true,
            action,
            message: `Merged ${entries.length} properties`,
            timestamp: nowIso(),
          },
        );
        return { dataHandles: [handle] };
      },
    },

    propertyRemove: {
      description: "Remove a frontmatter property from a note",
      arguments: z.object({
        file: z.string().describe("Path to note"),
        name: z.string().describe("Property name to remove"),
        allowDotObsidian: z.boolean().optional(),
      }),
      execute: async (args, context) => {
        const backend = selectBackend(context.globalArgs, "propertyRemove");
        let action: WriteAction = "updated";

        if (backend === "fs") {
          const globalArgs = await withVaultRoot(context.globalArgs);
          const target = await resolveVaultPathSafe(globalArgs, args.file, {
            allowDotObsidian: args.allowDotObsidian,
          });
          const existing = await Deno.readTextFile(target.absolutePath);
          const next = removeProperty(existing, args.name);
          // existing is always a non-null string here (readTextFile throws on
          // a missing file), so this can only resolve to "unchanged" or
          // "updated" — never "created".
          action = classifyWrite(existing, next);
          if (action !== "unchanged") {
            await writeAtomic(
              target.absolutePath,
              next,
              globalArgs.defaultFileMode as number,
            );
          }
        } else {
          await runObsidian("property:remove", {
            ...fileParam(args.file),
            name: args.name,
          }, context.globalArgs.vault);
        }

        const handle = await context.writeResource(
          "operationResult",
          "propertyRemove",
          {
            operation: "property:remove",
            file: args.file,
            success: true,
            action,
            message: `Removed ${args.name}`,
            timestamp: nowIso(),
          },
        );
        return { dataHandles: [handle] };
      },
    },
  },
};

/**
 * Obsidian property type for a JavaScript value, or undefined when the default
 * text type is right. Keeps the CLI backend storing the same type the
 * filesystem backend would write through the YAML document.
 */
export function propertyTypeHint(value: unknown): string | undefined {
  if (Array.isArray(value)) return "list";
  if (typeof value === "boolean") return "checkbox";
  if (typeof value === "number") return "number";
  return undefined;
}

/** Interpret a CLI-style string value against its declared property type. */
export function coerceProperty(
  value: string,
  type: string | undefined,
): unknown {
  switch (type) {
    case "list":
      try {
        const parsed = JSON.parse(value);
        return Array.isArray(parsed) ? parsed : [value];
      } catch {
        return value.split(",").map((v) => v.trim()).filter(Boolean);
      }
    case "number": {
      const n = Number(value);
      return Number.isFinite(n) ? n : value;
    }
    case "checkbox":
      return value === "true" || value === "yes" || value === "1";
    default:
      return value;
  }
}
