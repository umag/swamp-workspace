import { z } from "npm:zod@4";
import { normalize as posixNormalize } from "jsr:@std/path@1/posix";

const GlobalArgsSchema = z.object({
  zipPath: z.string().describe("Path to Telegram channel export zip file"),
  vault: z.string().describe("Obsidian vault name"),
  folder: z.string().default("Telegram").describe(
    "Target folder in Obsidian vault for imported notes",
  ),
  attachmentsFolder: z.string().default("attachments").describe(
    "Attachments folder name inside the target folder",
  ),
  vaultRoot: z.string().optional().describe(
    "Absolute path to the Obsidian vault directory. When set, the note is written directly to disk (no Obsidian CLI, no desktop app needed) instead of resolving the vault path and creating the note through the Obsidian CLI.",
  ),
});

// --- Path confinement (vault write destination) ---------------------------
//
// Copied (verbatim, same names/comments) from
// obsidian-vault/extensions/models/obsidian_vault.ts -- see PR #56 for the
// rationale. Swamp bundles each extension independently, so this ~60-line
// block is duplicated rather than shared across extensions. Used only for
// the headless vaultRoot note-write destination below -- unrelated to
// isPathContained/safeCopyMedia's extractDir confinement (LB-1) further down.

/**
 * A caller-supplied vault-relative path resolved against `vaultRoot` and
 * validated to stay inside it. Returned by `resolveVaultPath`/
 * `resolveVaultPathSafe` below.
 */
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
  for (const raw of path.split("/")) {
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

// --- Atomic write (vault write destination) --------------------------------
//
// Copied (verbatim, same names/comments) from
// obsidian-vault/extensions/models/obsidian_vault.ts (PR #56). No
// defaultFileMode/defaultDirectoryMode global arguments exist on this model,
// so DEFAULT_FILE_MODE/DEFAULT_DIRECTORY_MODE below stand in for them.

const DEFAULT_FILE_MODE = 0o644;
const DEFAULT_DIRECTORY_MODE = 0o755;

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

const ImportResultSchema = z.object({
  channel: z.string(),
  totalMessages: z.number(),
  notesCreated: z.number(),
  imagesCopied: z.number(),
  filesCopied: z.number(),
  errors: z.array(z.string()),
  timestamp: z.iso.datetime(),
});

const PostSchema = z.object({
  id: z.number(),
  date: z.string(),
  text: z.string(),
  photo: z.string().optional(),
  file: z.string().optional(),
  forwardedFrom: z.string().optional(),
  replyTo: z.number().optional(),
  timestamp: z.iso.datetime(),
});

/**
 * Top-level export shape guard (telegram-import-latent-bugs LB-5, MEDIUM).
 * Previously `data.name`/`data.messages.filter(...)` ran directly against
 * whatever `JSON.parse` returned, with no validation at all: a missing
 * `messages` array threw an opaque `TypeError` deep inside `.filter()`, and a
 * missing `name` silently rendered the literal string `"undefined"` into
 * every note's `channel` frontmatter line instead of failing loudly. Used
 * only to VALIDATE (fail closed with a clear message) — `data` itself stays
 * whatever `JSON.parse` returned (see the `import` method below), so every
 * existing per-message field access keeps its prior (permissive) typing;
 * this schema does not describe individual message shapes.
 */
const ExportSchema = z.object({
  name: z.string(),
  messages: z.array(z.unknown()),
});

/**
 * Size guard for the export's `result.json` (telegram-import-latent-bugs
 * LB-8, LOW). Previously nothing bounded it at all -- an oversized
 * `result.json` (malicious or just an unusually large channel history) was
 * read into memory and handed to `JSON.parse` regardless of size. 50 MB is
 * generous for a `result.json` (media itself is separate, so even a
 * multi-year, high-volume channel export's metadata stays well under this),
 * while still bounding worst-case memory use.
 */
const MAX_RESULT_JSON_BYTES = 50_000_000;

// Run an obsidian CLI command and return its trimmed stdout.
async function runObsidian(
  command: string,
  params: Record<string, string | undefined>,
  vault: string,
  bareFlags: string[] | undefined = undefined,
) {
  const args = [command];
  args.push(`vault=${vault}`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) {
      args.push(`${key}=${value}`);
    }
  }
  if (bareFlags) {
    for (const flag of bareFlags) {
      args.push(flag);
    }
  }

  const proc = new Deno.Command("obsidian", {
    args,
    stdout: "piped",
    stderr: "piped",
  });

  const output = await proc.output();
  const stderr = new TextDecoder().decode(output.stderr).trim();
  const stdout = new TextDecoder().decode(output.stdout).trim();

  if (!output.success) {
    throw new Error(
      `obsidian ${command} failed (exit ${output.code}): ${stderr || stdout}`,
    );
  }
  return stdout;
}

// Resolve obsidian vault filesystem path
async function getVaultPath(vault: string): Promise<string> {
  const proc = new Deno.Command("obsidian", {
    args: ["vault", `vault=${vault}`, "info=path"],
    stdout: "piped",
    stderr: "piped",
  });
  const output = await proc.output();
  const stdout = new TextDecoder().decode(output.stdout).trim();

  if (!output.success || !stdout) {
    throw new Error(`Cannot resolve vault path for "${vault}"`);
  }
  return stdout;
}

// Convert Telegram text (string | array of text entities) to markdown
function telegramTextToMarkdown(text: unknown): string {
  if (typeof text === "string") return text;
  if (!Array.isArray(text)) return "";

  return text
    .map((part) => {
      if (typeof part === "string") return part;
      if (typeof part === "object" && part !== null) {
        switch (part.type) {
          case "text_link":
            return `[${part.text}](${part.href})`;
          case "link":
            return part.text;
          case "bold":
            return `**${part.text}**`;
          case "italic":
            return `*${part.text}*`;
          case "code":
            return `\`${part.text}\``;
          case "pre":
            return `\`\`\`\n${part.text}\n\`\`\``;
          case "strikethrough":
            return `~~${part.text}~~`;
          case "mention":
          case "hashtag":
          case "email":
          case "phone":
          case "plain":
          default:
            return part.text || "";
        }
      }
      return "";
    })
    .join("");
}

// Generate a slug from date + id for the note filename
function noteSlug(msg: Record<string, unknown>): string {
  const date = (msg.date as string).split("T")[0]; // 2020-09-15
  return `${date}-${msg.id}`;
}

/**
 * Reject a note slug containing a `/` or a `..` segment
 * (telegram-import-latent-bugs LB-2, MEDIUM). `noteSlug` builds
 * `${date}-${msg.id}` straight from the export's attacker/data-controlled
 * `msg.id` (LB-5 only validates the top-level export shape, never individual
 * message fields), so a crafted string id like
 * `"101/../../../../tmp/evil-note"` reached the CLI `create path=` argument
 * verbatim — the vaultRoot branch below is already confined by
 * `resolveVaultPathSafe`, but the CLI branch passes `notePath` straight
 * through with no check of its own. Called as the FIRST statement inside the
 * note-create try below, so a rejection lands in the existing catch: the
 * note for that message is skipped and recorded in `errors[]`, and the post
 * resource is still written — same shape as every other per-item failure in
 * this loop.
 */
function assertSafeSlug(slug: string): void {
  const segments = slug.split("/");
  if (segments.length > 1 || segments.some((segment) => segment === "..")) {
    throw new Error(`Unsafe note slug (path traversal): "${slug}"`);
  }
}

/**
 * Escape a string for embedding inside a YAML double-quoted scalar
 * (telegram-import-latent-bugs LB-3, MEDIUM). `channel`, `forwarded_from`,
 * and the note `title` are interpolated straight from the Telegram export
 * (attacker/data-controlled) into a hand-built `"..."` frontmatter value with
 * no escaping — an embedded `"` closed the scalar early, and an embedded
 * CR/LF then let arbitrary extra YAML keys (e.g. `admin: true`) ride in on
 * the same line, landing as sibling keys in the note's frontmatter block.
 * Backslash is escaped FIRST so an already-escaped sequence in the input is
 * never re-escaped by a later replace. Byte-identical to the previous bare
 * interpolation for any input with no backslash/quote/control character (the
 * common case).
 */
function yamlDq(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(
      // deno-lint-ignore no-control-regex
      /[\x00-\x08\x0b\x0c\x0e-\x1f]/g,
      (ch) => `\\x${ch.charCodeAt(0).toString(16).padStart(2, "0")}`,
    );
}

/**
 * Path-containment guard (telegram-import-latent-bugs LB-1, HIGH). Both
 * `base` and `candidate` are posix-normalized — collapsing `..`/`.`
 * segments and redundant slashes — BEFORE the containment check runs, so a
 * traversal payload can never slip past a naive pre-normalization
 * `startsWith`. The prefix compare requires a trailing separator (or exact
 * equality) so a sibling directory that merely shares `base` as a string
 * prefix (e.g. base `/tmp/x` and candidate `/tmp/xy/evil`) is never
 * mistaken for containment.
 *
 * Upgraded (swamp-workspace #57) from lexical-only to realpath-aware: once
 * the lexical check passes, every existing path segment between `base`'s
 * realpath and `candidate` is walked with `Deno.lstat`, refusing to follow
 * any symlink — closing the "symlink created inside base that points
 * outside it" residual the lexical-only version documented (see
 * CHANGELOG.md). A segment that does not exist yet is not an error: the
 * caller's own `Deno.copyFile` raises its own NotFound, same as before this
 * change — this only refuses a symlink that is actually there.
 */
async function isPathContained(
  base: string,
  candidate: string,
): Promise<boolean> {
  const normalizedBase = posixNormalize(base);
  const normalizedCandidate = posixNormalize(candidate);
  if (
    normalizedCandidate !== normalizedBase &&
    !normalizedCandidate.startsWith(`${normalizedBase}/`)
  ) {
    return false;
  }

  let realBase: string;
  try {
    realBase = await Deno.realPath(base);
  } catch {
    return false; // extractDir itself is unreadable — fail closed
  }

  const relative = normalizedCandidate === normalizedBase
    ? ""
    : normalizedCandidate.slice(normalizedBase.length + 1);
  const segments = relative ? relative.split("/") : [];
  let current = realBase;
  for (const segment of segments) {
    current = `${current}/${segment}`;
    let info: Deno.FileInfo;
    try {
      info = await Deno.lstat(current);
    } catch {
      break; // does not exist yet — nothing to follow
    }
    if (info.isSymlink) {
      return false; // refuse to follow a symlink inside extractDir
    }
  }
  return true;
}

/**
 * Copy one media file from the export's `extractDir` into the vault's
 * attachments folder, guarded by `isPathContained` (LB-1). `srcFile` is
 * checked for containment BEFORE `Deno.copyFile` ever runs — an escaping
 * source is never opened; it is recorded in `errors` and the copy is
 * skipped, same shape as the pre-existing per-item catch below (the note
 * for the message is still created either way). Returns whether the copy
 * actually happened, so each call site can drive its own counter/embed-line
 * side effects.
 */
async function safeCopyMedia(
  extractDir: string,
  srcFile: string,
  destFile: string,
  label: string,
  errors: string[],
): Promise<boolean> {
  if (!(await isPathContained(extractDir, srcFile))) {
    errors.push(
      `Refused to copy ${label}: source path escapes extractDir ("${srcFile}")`,
    );
    return false;
  }
  try {
    await Deno.copyFile(srcFile, destFile);
    return true;
  } catch (e) {
    errors.push(
      `Failed to copy ${label}: ${e instanceof Error ? e.message : String(e)}`,
    );
    return false;
  }
}

/**
 * Telegram channel export importer model: parses a Telegram JSON export zip and
 * writes posts, images, files, and videos into an Obsidian vault.
 */
export const model = {
  type: "@magistr/telegram/import",
  version: "2026.08.02.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    result: {
      description: "Import summary",
      schema: ImportResultSchema,
      lifetime: "infinite",
      garbageCollection: 5,
    },
    post: {
      description: "Individual imported post",
      schema: PostSchema,
      lifetime: "infinite",
      garbageCollection: 5,
    },
  },
  upgrades: [
    {
      fromVersion: "2026.03.28.1",
      toVersion: "2026.03.28.2",
      description: "Switch from zip.js to unzip CLI for extraction",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      fromVersion: "2026.03.28.2",
      toVersion: "2026.05.25.1",
      description:
        "Lineage-repair bridge (no resource schema change) -- closes the gap between the upgrades[] tail (2026.03.28.2) and the shipped 2026.07.16.2 initial release; see CHANGELOG.md 2026.08.01.1.",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      fromVersion: "2026.05.25.1",
      toVersion: "2026.07.16.2",
      description:
        "Lineage-repair bridge (no resource schema change) -- see CHANGELOG.md 2026.08.01.1.",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      fromVersion: "2026.07.16.2",
      toVersion: "2026.08.01.1",
      description:
        "Path-containment guard (isPathContained/safeCopyMedia) applied at the photo/file/video Deno.copyFile sites, closing telegram-import-latent-bugs LB-1 (HIGH path-traversal). No resource schema change.",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      fromVersion: "2026.08.01.1",
      toVersion: "2026.08.01.2",
      description:
        "Add a headless vaultRoot filesystem backend (swamp-workspace #57, mirrors PR #56's obsidian-vault backend split): the note is written directly to disk via a confined atomic write when vaultRoot is set, instead of the Obsidian CLI. Upgrades isPathContained/safeCopyMedia (extractDir confinement) from lexical-only to realpath-aware, closing the documented symlink-escape residual. No resource schema change.",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      fromVersion: "2026.08.01.2",
      toVersion: "2026.08.02.1",
      description:
        "Real-fix all eight remaining latent bugs (telegram-import-latent-bugs LB-2..LB-9): note-slug path-traversal guard (LB-2), YAML frontmatter escaping (LB-3), per-message error isolation so one malformed message no longer aborts the whole import (LB-4), top-level export shape validation (LB-5), a bounded+success-checked `find` subprocess (LB-6), code-point-safe 500-unit text truncation (LB-7), a result.json size guard (LB-8), and leading-dash zipPath normalization (LB-9). No resource schema change.",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
  ],
  methods: {
    import: {
      description:
        "Parse Telegram export zip and import posts with images into Obsidian vault",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const { zipPath, vault, folder, attachmentsFolder, vaultRoot } =
          context.globalArgs;
        const logger = context.logger;

        // Extract zip to temp directory
        const tmpDir = await Deno.makeTempDir({ prefix: "telegram-import-" });

        try {
          // A zipPath starting with "-" is normalized to a "./"-relative form
          // (telegram-import-latent-bugs LB-9, LOW): the argv array below
          // already closes command-injection (every Deno.Command call passes
          // an argv array, never a shell string), but Info-ZIP's `unzip` does
          // not honor a `--` end-of-options marker, so an unnormalized
          // leading-dash zipPath would still be positionally misread as a
          // flag by a real unzip binary.
          const safeZip = zipPath.startsWith("-") ? `./${zipPath}` : zipPath;
          const unzipProc = new Deno.Command("unzip", {
            args: ["-o", safeZip, "-d", tmpDir],
            stdout: "piped",
            stderr: "piped",
          });
          const unzipOut = await unzipProc.output();
          if (!unzipOut.success) {
            const stderr = new TextDecoder().decode(unzipOut.stderr);
            throw new Error(`unzip failed: ${stderr}`);
          }

          // Find result.json in extracted dir. Bounded by a timeout, and the
          // subprocess exit status is checked explicitly
          // (telegram-import-latent-bugs LB-6, LOW): previously only stdout
          // was read, with no timeout and no success/code check -- a hung or
          // genuinely FAILING find (stale mount, permission error) was
          // indistinguishable from "ran fine, matched nothing" (both
          // surfaced the identical "No result.json found" message), and a
          // wedged find could hang the import forever with no way to report
          // back.
          const FIND_TIMEOUT_MS = 30_000;
          const findOut = await (async () => {
            const findAbort = new AbortController();
            const findTimer = setTimeout(
              () => findAbort.abort(),
              FIND_TIMEOUT_MS,
            );
            try {
              const findProc = new Deno.Command("find", {
                args: [tmpDir, "-name", "result.json", "-type", "f"],
                stdout: "piped",
                stderr: "piped",
                signal: findAbort.signal,
              });
              return await findProc.output();
            } finally {
              clearTimeout(findTimer);
            }
          })();
          if (!findOut.success) {
            const stderr = new TextDecoder().decode(findOut.stderr);
            throw new Error(`find failed (exit ${findOut.code}): ${stderr}`);
          }
          const resultPath = new TextDecoder()
            .decode(findOut.stdout)
            .trim()
            .split("\n")[0];
          if (!resultPath) {
            throw new Error("No result.json found in zip archive");
          }

          const extractDir = resultPath.replace("/result.json", "");

          // Size guard (telegram-import-latent-bugs LB-8, LOW): reject an
          // oversized result.json BEFORE it is ever read into memory or
          // handed to JSON.parse -- previously nothing bounded either.
          const resultInfo = await Deno.stat(resultPath);
          if (resultInfo.size > MAX_RESULT_JSON_BYTES) {
            throw new Error(
              `result.json is too large to import (${resultInfo.size} bytes > ${MAX_RESULT_JSON_BYTES} byte limit)`,
            );
          }

          const rawJson = await Deno.readTextFile(resultPath);
          const data = JSON.parse(rawJson);

          // Validate the top-level export shape (telegram-import-latent-bugs
          // LB-5, MEDIUM) before trusting data.name/data.messages -- see
          // ExportSchema above. `data` itself is left as whatever
          // JSON.parse returned (not replaced by the parsed/narrowed
          // value), so every per-message field access below keeps its prior
          // permissive typing; this only guards the shape check that used to
          // be entirely absent.
          const shapeCheck = ExportSchema.safeParse(data);
          if (!shapeCheck.success) {
            throw new Error(
              `Invalid Telegram export: ${shapeCheck.error.message}`,
            );
          }

          const channelName = data.name;

          // Filter actual messages (skip service messages)
          const messages = data.messages.filter((m) => m.type === "message");

          logger
            .info`Parsing ${messages.length} messages from channel "${channelName}"`;

          // Resolve vault path for copying binary files. vaultRoot (headless,
          // no Obsidian app needed) takes precedence over the CLI vault-name
          // lookup, which is kept as the fallback.
          const vaultPath = vaultRoot || await getVaultPath(vault);
          const attachFolder = `${folder}/${attachmentsFolder}`;
          const attachDiskPath = `${vaultPath}/${attachFolder}`;
          await Deno.mkdir(attachDiskPath, { recursive: true });

          const errors: string[] = [];
          let notesCreated = 0;
          let imagesCopied = 0;
          let filesCopied = 0;
          const dataHandles: unknown[] = [];

          for (const msg of messages) {
            // Per-message error isolation (telegram-import-latent-bugs LB-4,
            // MEDIUM): the ENTIRE per-message body used to run uncaught --
            // one bad message (e.g. a non-string `date`, which throws inside
            // noteSlug below) rejected the whole `import` call, and since the
            // `result` summary is only written AFTER this loop completes
            // (unchanged, still true below), NOTHING was ever reported back,
            // even for messages already processed successfully before the
            // throw. Every failure is now recorded in `errors[]` and the loop
            // moves on to the next message, same shape as the pre-existing
            // per-item copy/create failure handling below.
            try {
              const slug = noteSlug(msg);
              const text = telegramTextToMarkdown(msg.text);
              const date = msg.date;
              const msgId = msg.id;

              // Build frontmatter. title/channel/forwarded_from are escaped
              // with yamlDq (LB-3, MEDIUM) -- see its docstring above.
              const fm = [
                "---",
                `title: "Post ${yamlDq(String(msgId))}"`,
                `date: ${date}`,
                `source: telegram`,
                `channel: "${yamlDq(String(channelName))}"`,
                `telegram_id: ${msgId}`,
              ];
              if (msg.forwarded_from) {
                fm.push(
                  `forwarded_from: "${yamlDq(String(msg.forwarded_from))}"`,
                );
              }
              if (msg.reply_to_message_id) {
                fm.push(`reply_to: ${msg.reply_to_message_id}`);
              }
              fm.push("tags:", "  - telegram", "---", "");

              const body: string[] = [];

              if (msg.forwarded_from) {
                body.push(`> Forwarded from **${msg.forwarded_from}**`, "");
              }

              if (text.trim()) {
                body.push(text, "");
              }

              // Handle photo — srcFile is containment-guarded (LB-1) by
              // safeCopyMedia before Deno.copyFile ever runs.
              let photoFilename;
              if (msg.photo) {
                const srcFile = `${extractDir}/${msg.photo}`;
                photoFilename = msg.photo.split("/").pop();
                const copied = await safeCopyMedia(
                  extractDir,
                  srcFile,
                  `${attachDiskPath}/${photoFilename}`,
                  `image ${photoFilename}`,
                  errors,
                );
                if (copied) {
                  imagesCopied++;
                  body.push(`![[${attachFolder}/${photoFilename}]]`, "");
                }
              }

              // Handle file attachment (PDF etc) — skip thumbnails and videos
              // handled below. srcFile is containment-guarded (LB-1) by
              // safeCopyMedia, applied AFTER the _thumb skip so thumbnails
              // stay silently skipped and only true escapes record an error.
              if (
                msg.file &&
                typeof msg.file === "string" &&
                msg.media_type !== "video_file"
              ) {
                const fileName = msg.file.split("/").pop();
                if (!fileName.endsWith("_thumb.jpg")) {
                  const srcFile = `${extractDir}/${msg.file}`;
                  const copied = await safeCopyMedia(
                    extractDir,
                    srcFile,
                    `${attachDiskPath}/${fileName}`,
                    `file ${fileName}`,
                    errors,
                  );
                  if (copied) {
                    filesCopied++;
                    body.push(`![[${attachFolder}/${fileName}]]`, "");
                  }
                }
              }

              // Handle video — srcFile is containment-guarded (LB-1) by
              // safeCopyMedia before Deno.copyFile ever runs.
              if (msg.media_type === "video_file" && msg.file) {
                const fileName = msg.file.split("/").pop();
                const srcFile = `${extractDir}/${msg.file}`;
                const copied = await safeCopyMedia(
                  extractDir,
                  srcFile,
                  `${attachDiskPath}/${fileName}`,
                  `video ${fileName}`,
                  errors,
                );
                if (copied) {
                  filesCopied++;
                  body.push(`![[${attachFolder}/${fileName}]]`, "");
                }
              }

              // Create the note: a confined direct write when vaultRoot is
              // set (headless, no Obsidian app needed), the Obsidian CLI
              // otherwise.
              const noteContent = fm.join("\n") + body.join("\n");
              const notePath = `${folder}/${slug}`;

              try {
                // LB-2 guard: reject a slug containing a path-traversal
                // segment before it ever reaches either branch below -- see
                // assertSafeSlug's docstring above.
                assertSafeSlug(slug);
                if (vaultRoot) {
                  const noteGlobalArgs: Record<string, unknown> = {
                    vaultRoot,
                  };
                  const noteTarget = await resolveVaultPathSafe(
                    noteGlobalArgs,
                    `${notePath}.md`,
                  );
                  await ensureParentDir(
                    noteTarget.absolutePath,
                    DEFAULT_DIRECTORY_MODE,
                  );
                  await writeAtomic(
                    noteTarget.absolutePath,
                    noteContent,
                    DEFAULT_FILE_MODE,
                  );
                } else {
                  const noteKey = notePath.includes("/") ? "path" : "name";
                  await runObsidian(
                    "create",
                    { [noteKey]: notePath, content: noteContent },
                    vault,
                    ["overwrite"],
                  );
                }
                notesCreated++;
              } catch (e) {
                errors.push(
                  `Failed to create note ${notePath}: ${
                    e instanceof Error ? e.message : String(e)
                  }`,
                );
              }

              // Write post resource (factory pattern). Truncated by CODE
              // POINT, not raw UTF-16 code unit (telegram-import-latent-bugs
              // LB-7, LOW): `text.substring(0, 500)` could cut a surrogate
              // pair in half, leaving a lone (unpaired) high surrogate at the
              // end of the truncated text.
              const postHandle = await context.writeResource("post", slug, {
                id: msgId,
                date,
                text: Array.from(text).slice(0, 500).join(""),
                photo: photoFilename,
                forwardedFrom: msg.forwarded_from || undefined,
                replyTo: msg.reply_to_message_id || undefined,
                timestamp: new Date().toISOString(),
              });
              dataHandles.push(postHandle);
            } catch (e) {
              errors.push(
                `Skipped message (id ${msg.id}): ${
                  e instanceof Error ? e.message : String(e)
                }`,
              );
              continue;
            }
          }

          // Write summary
          const summaryHandle = await context.writeResource("result", "main", {
            channel: channelName,
            totalMessages: messages.length,
            notesCreated,
            imagesCopied,
            filesCopied,
            errors,
            timestamp: new Date().toISOString(),
          });
          dataHandles.push(summaryHandle);

          logger
            .info`Import complete: ${notesCreated} notes, ${imagesCopied} images, ${filesCopied} files. Errors: ${errors.length}`;

          return { dataHandles };
        } finally {
          // Clean up temp directory
          await Deno.remove(tmpDir, { recursive: true }).catch(() => {});
        }
      },
    },
  },
};
