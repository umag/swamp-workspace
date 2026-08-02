import { z } from "npm:zod@4";

const GlobalArgsSchema = z.object({
  historyDir: z.string().describe(
    "Path to Psi/Psi+ Jabber client history directory (containing .history and conference log files)",
  ),
  vaultRoot: z.string().optional().describe(
    "Absolute path to the Obsidian vault directory. When set, importToObsidian writes notes directly to this directory (no Obsidian CLI, no desktop app needed) and takes precedence over CLI-based vault-name resolution. Overridden per-call by the importToObsidian method's own vaultPath argument.",
  ),
  timeoutMs: z.number().optional().describe(
    "Timeout (ms) for the 'obsidian' CLI subprocess used to resolve a vault name to a filesystem path. Only applies when neither vaultPath (method argument) nor vaultRoot (global argument) is set. Defaults to 30000 (30s).",
  ),
  obsidianBin: z.string().optional().describe(
    "Path or command name for the Obsidian CLI binary invoked to resolve a vault name to a path. Defaults to the bare command name 'obsidian' (resolved via $PATH). Only applies when neither vaultPath nor vaultRoot is set.",
  ),
  maxFileBytes: z.number().optional().describe(
    "Maximum size, in bytes, of a single history file read into memory. Files larger than this are skipped (with a warning) rather than read. Defaults to 52428800 (50 MiB).",
  ),
});

// --- Path confinement ------------------------------------------------------
//
// Copied (verbatim, same names/comments) from
// obsidian-vault/extensions/models/obsidian_vault.ts -- see PR #56 for the
// rationale. Swamp bundles each extension independently, so this ~60-line
// block is duplicated rather than shared across extensions.

/**
 * A caller-supplied path resolved and confined against a vault's root
 * directory -- returned by resolveVaultPath/resolveVaultPathSafe below.
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

const MessageSchema = z.object({
  timestamp: z.iso.datetime(),
  direction: z.enum(["from", "to", "system"]),
  sender: z.string().optional(),
  body: z.string(),
  flags: z.string().optional(),
});

const ConversationSchema = z.object({
  jid: z.string().describe("JID of the contact or conference room"),
  chatType: z.enum(["dm", "conference"]),
  account: z.string().optional().describe(
    "Own account JID (for conference logs)",
  ),
  messageCount: z.number(),
  firstMessage: z.iso.datetime().optional(),
  lastMessage: z.iso.datetime().optional(),
  messages: z.array(MessageSchema),
});

const SummarySchema = z.object({
  historyDir: z.string(),
  totalConversations: z.number(),
  totalDMs: z.number(),
  totalConferences: z.number(),
  totalMessages: z.number(),
  conversations: z.array(z.object({
    jid: z.string(),
    chatType: z.enum(["dm", "conference"]),
    messageCount: z.number(),
    firstMessage: z.string().optional(),
    lastMessage: z.string().optional(),
  })),
  timestamp: z.iso.datetime(),
});

function decodeJid(filename: string): string {
  // URL-decode %XX sequences and replace _at_ with @
  const withAt = filename.replace(/_at_/g, "@");
  try {
    return decodeURIComponent(withAt);
  } catch {
    // LB1 fix: a malformed % escape (e.g. "%ZZ") makes decodeURIComponent
    // throw a URIError. Before this fix that exception propagated out of
    // listHistoryFiles' `for await` loop unguarded, aborting EVERY method
    // for the WHOLE directory over a single poisoned filename. Sanitize, not
    // abort: fall back to the _at_-replaced raw string so every OTHER file
    // in the directory stays reachable.
    return withAt;
  }
}

function parsePipeDelimited(content: string): Array<{
  timestamp: string;
  direction: string;
  body: string;
  flags: string;
}> {
  const messages: Array<{
    timestamp: string;
    direction: string;
    body: string;
    flags: string;
  }> = [];

  // Format: |timestamp|version|direction|flags|body
  // Lines start with |
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("|")) continue;

    const parts = trimmed.substring(1).split("|");
    if (parts.length < 5) continue;

    const timestamp = parts[0];
    const direction = parts[2]; // "from" or "to"
    const flags = parts[3];
    const body = parts.slice(4).join("|").replace(/\\n/g, "\n");

    if (!timestamp || !direction) continue;

    messages.push({
      timestamp: timestamp.endsWith("Z") ? timestamp : timestamp + "Z",
      direction,
      body,
      flags,
    });
  }

  return messages;
}

// LB4 fix: parsePipeDelimited's blind `timestamp + "Z"` append and
// unvalidated `direction` string pass straight through untouched -- in a
// real swamp instance `context.writeResource` would validate the built
// resource against ConversationSchema (whose `messages[].timestamp` is
// `z.iso.datetime()` and `.direction` a 3-value enum) and reject the WHOLE
// resource, aborting `read` for every OTHER well-formed message in the same
// conversation too. Guard post-parse instead: validate each candidate
// message against the model's own MessageSchema and drop (with a warning)
// only the invalid ones, localizing the damage the same way LB1's decodeJid
// fix localizes a single bad filename -- valid sibling messages survive.
function filterValidMessages(
  msgs: Array<{
    timestamp: string;
    direction: string;
    body: string;
    flags?: string;
  }>,
  jid: string,
  logger: { warn: (message: string) => void },
): Array<{
  timestamp: string;
  direction: string;
  body: string;
  flags?: string;
}> {
  const valid: typeof msgs = [];
  for (const msg of msgs) {
    const result = MessageSchema.safeParse({
      timestamp: msg.timestamp,
      direction: msg.direction,
      body: msg.body,
      flags: msg.flags,
    });
    if (result.success) {
      valid.push(msg);
    } else {
      logger.warn(
        `Dropping invalid message in ${jid}: ${
          result.error.issues[0]?.message ?? "schema validation failed"
        }`,
      );
    }
  }
  return valid;
}

function parsePlainText(content: string): Array<{
  timestamp: string;
  sender: string;
  body: string;
}> {
  const messages: Array<{
    timestamp: string;
    sender: string;
    body: string;
  }> = [];

  // Format: "2012-05-01 12:06:02  Nickname: message text"
  const lineRegex =
    /^(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2})\s{2}(.+?):\s(.*)$/;

  for (const line of content.split("\n")) {
    const match = line.match(lineRegex);
    if (!match) continue;

    const [, dateStr, sender, body] = match;
    const timestamp = dateStr.replace(/\s+/, "T") + "Z";

    messages.push({ timestamp, sender, body });
  }

  return messages;
}

// LB6 fix: the subprocess previously carried no AbortSignal/timeout at all,
// so a hung `obsidian` CLI blocked the import indefinitely. LB7 fix: the
// binary is now resolved via the caller-supplied `obsidianBin` (defaulting
// to the bare "obsidian" PATH-resolved name, unchanged) instead of a literal
// hardcoded string. AbortSignal.timeout() is deliberately NOT used here (see
// livejournal_import.ts's runObsidian/getVaultPath for the same pattern) --
// a manual setTimeout/clearTimeout pair, always cleared in `finally`, avoids
// leaving a pending internal timer that op-sanitizers/FakeTime dislike.
async function getVaultPath(
  vault: string,
  timeoutMs: number,
  obsidianBin: string,
): Promise<string> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  const proc = new Deno.Command(obsidianBin, {
    args: ["vault", `vault=${vault}`, "info=path"],
    stdout: "piped",
    stderr: "piped",
    signal: ac.signal,
  });
  let output: Deno.CommandOutput;
  try {
    output = await proc.output();
  } finally {
    clearTimeout(timer);
  }
  if (!output.success) {
    const stderr = new TextDecoder().decode(output.stderr).trim();
    throw new Error(`Failed to resolve vault path: ${stderr}`);
  }
  return new TextDecoder().decode(output.stdout).trim();
}

function sanitizeFilename(jid: string): string {
  const cleaned = jid
    .replace(/[\/\\:*?"<>|#%\[\]{}]/g, "-")
    .replace(/\.+$/, "")
    .trim();
  // LB9 fix: a raw UTF-16 code-unit `.slice(0, 80)` can split a surrogate
  // pair straddling the boundary, emitting a lone unpaired high surrogate
  // (which either survives as-is or is silently substituted with U+FFFD by
  // the OS/runtime on write). `Array.from` iterates by Unicode code point,
  // so the cut can never land inside a surrogate pair.
  return Array.from(cleaned).slice(0, 80).join("");
}

// LB2 fix: escape a string for safe embedding INSIDE a double-quoted YAML
// scalar -- copied verbatim from livejournal_import.ts's yamlEscape (see
// that file for the full rationale). Order matters: backslashes are
// escaped FIRST so the backslashes this function itself introduces are
// never re-escaped by a later step. Byte-identical to the old
// `.replace(/"/g, '\\"')` for any input with no backslash/control character
// (the common case) -- only newline/CR/other-control/backslash-bearing
// input produces different (and now SAFE) output.
function yamlEscape(s: string): string {
  return s
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(
      // deno-lint-ignore no-control-regex
      /[\x00-\x08\x0b\x0c\x0e-\x1f]/g,
      (c) => "\\x" + c.charCodeAt(0).toString(16).padStart(2, "0"),
    );
}

// LB3b fix: a message body containing a literal frontmatter/hr delimiter
// line (`---`, `***`, `___`) renders inline as a raw delimiter line in the
// note body, letting an attacker-controlled body forge a second frontmatter
// block (or a spurious thematic break). Escape any body LINE that is,
// after trimming, exactly such a delimiter by prefixing it with a
// backslash -- Markdown's backslash-escape neutralizes the delimiter while
// leaving the visible text intact. Byte-stable for the overwhelmingly
// common case of a body with no such line.
const FRONTMATTER_DELIMITER_LINE = /^(-{3,}|_{3,}|\*{3,})$/;
function neutralizeBodyDelimiters(body: string): string {
  return body
    .split("\n")
    .map((line) =>
      FRONTMATTER_DELIMITER_LINE.test(line.trim()) ? `\\${line}` : line
    )
    .join("\n");
}

// LB8 fix: every method previously read each history file whole via
// `Deno.readTextFile` with no size guard anywhere -- a several-thousand
// message single file (or an adversarially huge one) was read entirely
// into memory unconditionally. `Deno.stat` first and skip (with a warning)
// any file over the caller-configured cap; well under the default 50 MiB
// cap, behavior is completely unchanged.
async function readFileWithCap(
  path: string,
  maxBytes: number,
  logger: { warn: (message: string) => void },
): Promise<string | undefined> {
  const info = await Deno.stat(path);
  if (info.size > maxBytes) {
    logger.warn(
      `Skipping ${path}: file size ${info.size} bytes exceeds maxFileBytes cap (${maxBytes})`,
    );
    return undefined;
  }
  return await Deno.readTextFile(path);
}

async function listHistoryFiles(historyDir: string): Promise<
  Array<{
    path: string;
    filename: string;
    chatType: "dm" | "conference";
    format: "pipe" | "plain";
    jid: string;
    account?: string;
  }>
> {
  const results: Array<{
    path: string;
    filename: string;
    chatType: "dm" | "conference";
    format: "pipe" | "plain";
    jid: string;
    account?: string;
  }> = [];

  for await (const entry of Deno.readDir(historyDir)) {
    if (!entry.isFile) continue;

    const name = entry.name;
    const fullPath = `${historyDir}/${name}`;

    // Conference plain text: account_in_room (no .history extension)
    const inMatch = name.match(/^(.+?)_in_(.+)$/);
    if (inMatch && !name.endsWith(".history") && !name.endsWith(".backup")) {
      results.push({
        path: fullPath,
        filename: name,
        chatType: "conference",
        format: "plain",
        jid: decodeJid(inMatch[2]),
        account: decodeJid(inMatch[1]),
      });
      continue;
    }

    // .history files - could be DM or conference
    if (name.endsWith(".history") && !name.endsWith(".backup")) {
      const baseName = name.replace(/\.history$/, "");
      const isConference = baseName.includes("conference.");
      results.push({
        path: fullPath,
        filename: name,
        chatType: isConference ? "conference" : "dm",
        format: "pipe",
        jid: decodeJid(baseName),
      });
      continue;
    }
  }

  return results.sort((a, b) => a.jid.localeCompare(b.jid));
}

/** Psi/Psi+ Jabber (XMPP) chat-history model: list, read, search, and import DMs and MUC conferences into an Obsidian vault as markdown notes. */
export const model = {
  type: "@magistr/jabber/history",
  version: "2026.08.02.1",
  upgrades: [
    {
      fromVersion: "2026.07.16.2",
      toVersion: "2026.08.01.1",
      description:
        "Lineage-repair bridge: 2026.08.01.1 (the headless vaultRoot filesystem backend, swamp-workspace #57) shipped without an upgrades[] entry. No resource schema change.",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      fromVersion: "2026.08.01.1",
      toVersion: "2026.08.02.1",
      description:
        "Fix latent bugs #1-4, #6-9: resilient decodeJid (#1), sanitizeFilename collision dedup (#2), YAML/body-delimiter escaping (#3), post-parse message schema guard (#4), timeout+obsidianBin+maxFileBytes on the obsidian CLI subprocess and file reads (#6-8), code-point-aware filename truncation (#9). Bug #5 (path traversal) was already fixed in 2026.08.01.1 and is untouched here. No resource schema change.",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
  ],
  globalArguments: GlobalArgsSchema,
  resources: {
    summary: {
      description: "Summary of all conversations in the history directory",
      schema: SummarySchema,
      lifetime: "infinite" as const,
      garbageCollection: 5,
    },
    conversation: {
      description: "Individual conversation with all messages",
      schema: ConversationSchema,
      lifetime: "infinite" as const,
      garbageCollection: 5,
    },
  },
  methods: {
    list: {
      description:
        "List all conversations (DMs and conferences) with message counts",
      arguments: z.object({
        chatType: z.enum(["all", "dm", "conference"]).default("all").describe(
          "Filter by conversation type",
        ),
      }),
      execute: async (args, context) => {
        const historyDir = context.globalArgs.historyDir + "/history";
        const maxFileBytes =
          (context.globalArgs.maxFileBytes as number | undefined) ??
            52428800;
        const files = await listHistoryFiles(historyDir);

        const filtered = args.chatType === "all"
          ? files
          : files.filter((f) => f.chatType === args.chatType);

        const conversations: Array<{
          jid: string;
          chatType: "dm" | "conference";
          messageCount: number;
          firstMessage?: string;
          lastMessage?: string;
        }> = [];

        for (const file of filtered) {
          const content = await readFileWithCap(
            file.path,
            maxFileBytes,
            context.logger,
          );
          if (content === undefined) continue;

          if (file.format === "pipe") {
            const msgs = parsePipeDelimited(content);
            conversations.push({
              jid: file.jid,
              chatType: file.chatType,
              messageCount: msgs.length,
              firstMessage: msgs[0]?.timestamp,
              lastMessage: msgs[msgs.length - 1]?.timestamp,
            });
          } else {
            const msgs = parsePlainText(content);
            conversations.push({
              jid: file.jid,
              chatType: file.chatType,
              messageCount: msgs.length,
              firstMessage: msgs[0]?.timestamp,
              lastMessage: msgs[msgs.length - 1]?.timestamp,
            });
          }
        }

        const summary = {
          historyDir: context.globalArgs.historyDir,
          totalConversations: conversations.length,
          totalDMs: conversations.filter((c) => c.chatType === "dm").length,
          totalConferences:
            conversations.filter((c) => c.chatType === "conference").length,
          totalMessages: conversations.reduce(
            (sum, c) => sum + c.messageCount,
            0,
          ),
          conversations,
          timestamp: new Date().toISOString(),
        };

        const handle = await context.writeResource("summary", "main", summary);
        return { dataHandles: [handle] };
      },
    },
    read: {
      description: "Read messages from a specific conversation by JID pattern",
      arguments: z.object({
        jid: z.string().describe(
          "JID or substring to match (e.g. 'alice' or 'bob@jabber.example')",
        ),
        limit: z.number().default(0).describe(
          "Max messages to return (0 = all)",
        ),
      }),
      execute: async (args, context) => {
        const historyDir = context.globalArgs.historyDir + "/history";
        const maxFileBytes =
          (context.globalArgs.maxFileBytes as number | undefined) ??
            52428800;
        const files = await listHistoryFiles(historyDir);

        const searchTerm = args.jid.toLowerCase();
        const matching = files.filter((f) =>
          f.jid.toLowerCase().includes(searchTerm) ||
          f.filename.toLowerCase().includes(searchTerm.replace(/@/g, "_at_"))
        );

        if (matching.length === 0) {
          throw new Error(
            `No conversation found matching "${args.jid}". Use the 'list' method to see available conversations.`,
          );
        }

        const handles: unknown[] = [];

        for (const file of matching) {
          const content = await readFileWithCap(
            file.path,
            maxFileBytes,
            context.logger,
          );
          if (content === undefined) continue;
          let messages: Array<{
            timestamp: string;
            direction: string;
            sender?: string;
            body: string;
            flags?: string;
          }>;

          if (file.format === "pipe") {
            // LB4 fix: drop (with a warning) any message whose parsed
            // timestamp/direction fails the model's own MessageSchema,
            // instead of letting a single malformed message poison the
            // whole conversation resource -- see filterValidMessages.
            messages = filterValidMessages(
              parsePipeDelimited(content),
              file.jid,
              context.logger,
            );
          } else {
            messages = parsePlainText(content).map((m) => ({
              timestamp: m.timestamp,
              direction: "from" as const,
              sender: m.sender,
              body: m.body,
            }));
          }

          if (args.limit > 0) {
            messages = messages.slice(-args.limit);
          }

          const baseInstance = file.jid
            .replace(/@/g, "_at_")
            .replace(/\./g, "_")
            .replace(/[^a-zA-Z0-9_]/g, "_");
          const instanceName = file.account
            ? `${baseInstance}_via_${
              file.account.replace(/@/g, "_at_").replace(/\./g, "_").replace(
                /[^a-zA-Z0-9_]/g,
                "_",
              )
            }`
            : baseInstance;

          const conversation = {
            jid: file.jid,
            chatType: file.chatType,
            account: file.account,
            messageCount: messages.length,
            firstMessage: messages[0]?.timestamp,
            lastMessage: messages[messages.length - 1]?.timestamp,
            messages: messages.map((m) => ({
              timestamp: m.timestamp,
              direction: m.direction as "from" | "to" | "system",
              sender: m.sender,
              body: m.body,
              flags: m.flags,
            })),
          };

          const handle = await context.writeResource(
            "conversation",
            instanceName,
            conversation,
          );
          handles.push(handle);
        }

        return { dataHandles: handles };
      },
    },
    search: {
      description: "Search messages across all conversations by text pattern",
      arguments: z.object({
        query: z.string().describe("Text to search for (case-insensitive)"),
        chatType: z.enum(["all", "dm", "conference"]).default("all").describe(
          "Filter by conversation type",
        ),
        limit: z.number().default(100).describe("Max results to return"),
      }),
      execute: async (args, context) => {
        const historyDir = context.globalArgs.historyDir + "/history";
        const maxFileBytes =
          (context.globalArgs.maxFileBytes as number | undefined) ??
            52428800;
        const files = await listHistoryFiles(historyDir);

        const filtered = args.chatType === "all"
          ? files
          : files.filter((f) => f.chatType === args.chatType);

        const searchLower = args.query.toLowerCase();
        const allMatches: Array<{
          timestamp: string;
          direction: string;
          sender?: string;
          body: string;
          flags?: string;
          jid: string;
          conversationType: string;
        }> = [];

        for (const file of filtered) {
          const content = await readFileWithCap(
            file.path,
            maxFileBytes,
            context.logger,
          );

          if (content !== undefined) {
            if (file.format === "pipe") {
              for (const msg of parsePipeDelimited(content)) {
                if (msg.body.toLowerCase().includes(searchLower)) {
                  allMatches.push({
                    ...msg,
                    jid: file.jid,
                    conversationType: file.chatType,
                  });
                }
              }
            } else {
              for (const msg of parsePlainText(content)) {
                if (
                  msg.body.toLowerCase().includes(searchLower) ||
                  msg.sender.toLowerCase().includes(searchLower)
                ) {
                  allMatches.push({
                    timestamp: msg.timestamp,
                    direction: "from",
                    sender: msg.sender,
                    body: msg.body,
                    jid: file.jid,
                    conversationType: file.chatType,
                  });
                }
              }
            }
          }

          if (allMatches.length >= args.limit) break;
        }

        const results = allMatches.slice(0, args.limit);

        const summary = {
          historyDir: context.globalArgs.historyDir,
          totalConversations: 0,
          totalDMs: 0,
          totalConferences: 0,
          totalMessages: results.length,
          conversations: results.map((m) => ({
            jid: m.jid,
            chatType: m.conversationType as "dm" | "conference",
            messageCount: 1,
            firstMessage: m.timestamp,
            lastMessage: m.timestamp,
          })),
          timestamp: new Date().toISOString(),
        };

        const handle = await context.writeResource(
          "summary",
          "search",
          summary,
        );
        return { dataHandles: [handle] };
      },
    },
    importToObsidian: {
      description:
        "Import Jabber conversations as markdown notes into an Obsidian vault",
      arguments: z.object({
        vault: z.string().optional().describe(
          "Obsidian vault name (resolved via CLI)",
        ),
        vaultPath: z.string().optional().describe(
          "Direct filesystem path to the Obsidian vault (skips CLI resolution and the vaultRoot global argument)",
        ),
        folder: z.string().default("Jabber").describe(
          "Target folder inside the vault",
        ),
        chatType: z.enum(["all", "dm", "conference"]).default("all").describe(
          "Filter by conversation type",
        ),
      }),
      execute: async (args, context) => {
        // Precedence: the method's own vaultPath argument, then the global
        // vaultRoot argument (headless, no Obsidian app needed), then the
        // Obsidian CLI vault-name lookup (needs the desktop app running).
        const vaultRoot = context.globalArgs.vaultRoot as string | undefined;
        if (!args.vault && !args.vaultPath && !vaultRoot) {
          throw new Error(
            "Either 'vault' or 'vaultPath' must be provided (or set the vaultRoot global argument)",
          );
        }
        const timeoutMs =
          (context.globalArgs.timeoutMs as number | undefined) ?? 30000;
        const obsidianBin =
          (context.globalArgs.obsidianBin as string | undefined) ??
            "obsidian";
        const maxFileBytes =
          (context.globalArgs.maxFileBytes as number | undefined) ??
            52428800;
        const vaultPath = args.vaultPath || vaultRoot ||
          await getVaultPath(args.vault!, timeoutMs, obsidianBin);
        // Synthetic globalArgs so the copied resolveVaultPathSafe helper can
        // confine noteDir/notePath under vaultPath regardless of which of
        // the three precedence tiers produced it.
        const pathGlobalArgs: Record<string, unknown> = {
          vaultRoot: vaultPath,
        };
        const historyDir = context.globalArgs.historyDir + "/history";
        const files = await listHistoryFiles(historyDir);

        // For conferences that have both pipe and plain-text formats, prefer plain-text
        // (the _in_ files have sender nicknames). Keep pipe-format conferences that have
        // no plain-text counterpart (they'd otherwise be lost entirely).
        const plainTextJids = new Set(
          files
            .filter((f) => f.chatType === "conference" && f.format === "plain")
            .map((f) => f.jid),
        );
        const importable = files.filter(
          (f) =>
            !(
              f.chatType === "conference" &&
              f.format === "pipe" &&
              plainTextJids.has(f.jid)
            ),
        );
        const filtered = args.chatType === "all"
          ? importable
          : importable.filter((f) => f.chatType === args.chatType);

        const noteDirTarget = await resolveVaultPathSafe(
          pathGlobalArgs,
          args.folder,
        );
        const noteDir = noteDirTarget.absolutePath;
        await Deno.mkdir(noteDir, { recursive: true });

        let written = 0;
        let skipped = 0;
        const conversations: Array<{
          jid: string;
          chatType: "dm" | "conference";
          messageCount: number;
          firstMessage?: string;
          lastMessage?: string;
        }> = [];
        // LB2 fix: tracks how many times each sanitizeFilename() stem has
        // already been used in THIS run, so two distinct JIDs that collide
        // to the same filename (one with a literal "-", one with a "/" that
        // sanitizeFilename replaces with "-") get " (2)", " (3)", ... suffixes
        // instead of the second write silently clobbering the first.
        const usedStems = new Map<string, number>();

        for (const file of filtered) {
          const content = await readFileWithCap(
            file.path,
            maxFileBytes,
            context.logger,
          );
          if (content === undefined) {
            skipped++;
            continue;
          }
          let md = "";
          let msgCount = 0;
          let firstDate = "";
          let lastDate = "";

          if (file.format === "pipe") {
            // Pipe-delimited format (DMs or conferences without plain-text logs)
            const msgs = parsePipeDelimited(content);
            msgCount = msgs.length;
            if (msgs.length === 0) {
              skipped++;
              continue;
            }
            firstDate = msgs[0].timestamp.slice(0, 10);
            lastDate = msgs[msgs.length - 1].timestamp.slice(0, 10);

            const typeTag = file.chatType === "conference"
              ? "conference"
              : "dm";
            md += "---\n";
            md += `title: "${yamlEscape(file.jid)}"\n`;
            md += `type: ${typeTag}\n`;
            md += `jid: "${yamlEscape(file.jid)}"\n`;
            md += `messages: ${msgCount}\n`;
            md += `first_message: ${firstDate}\n`;
            md += `last_message: ${lastDate}\n`;
            md += `tags:\n  - jabber\n  - jabber-${typeTag}\n`;
            md += "---\n\n";

            let currentDate = "";
            for (const msg of msgs) {
              const dateStr = msg.timestamp.slice(0, 10);
              const timeStr = msg.timestamp.slice(11, 16);
              if (dateStr !== currentDate) {
                md += `\n### ${dateStr}\n\n`;
                currentDate = dateStr;
              }
              const arrow = msg.direction === "to" ? "→" : "←";
              md += `**${timeStr} ${arrow}** ${
                neutralizeBodyDelimiters(msg.body)
              }\n\n`;
            }
          } else {
            // Conference plain-text format
            const msgs = parsePlainText(content);
            msgCount = msgs.length;
            if (msgs.length === 0) {
              skipped++;
              continue;
            }
            firstDate = msgs[0].timestamp.slice(0, 10);
            lastDate = msgs[msgs.length - 1].timestamp.slice(0, 10);

            md += "---\n";
            md += `title: "${yamlEscape(file.jid)}"\n`;
            md += `type: conference\n`;
            md += `jid: "${yamlEscape(file.jid)}"\n`;
            if (file.account) {
              md += `account: "${yamlEscape(file.account)}"\n`;
            }
            md += `messages: ${msgCount}\n`;
            md += `first_message: ${firstDate}\n`;
            md += `last_message: ${lastDate}\n`;
            md += "tags:\n  - jabber\n  - jabber-conference\n";
            md += "---\n\n";

            let currentDate = "";
            for (const msg of msgs) {
              const dateStr = msg.timestamp.slice(0, 10);
              const timeStr = msg.timestamp.slice(11, 16);
              if (dateStr !== currentDate) {
                md += `\n### ${dateStr}\n\n`;
                currentDate = dateStr;
              }
              md += `**${timeStr} ${msg.sender}:** ${
                neutralizeBodyDelimiters(msg.body)
              }\n\n`;
            }
          }

          const rawStem = sanitizeFilename(file.jid);
          const priorUses = usedStems.get(rawStem) ?? 0;
          usedStems.set(rawStem, priorUses + 1);
          const safeFile = priorUses === 0
            ? rawStem
            : `${rawStem} (${priorUses + 1})`;
          const noteTarget = await resolveVaultPathSafe(
            pathGlobalArgs,
            `${args.folder}/${safeFile}.md`,
          );
          const notePath = noteTarget.absolutePath;

          try {
            await Deno.writeTextFile(notePath, md);
            written++;
            conversations.push({
              jid: file.jid,
              chatType: file.chatType,
              messageCount: msgCount,
              firstMessage: firstDate,
              lastMessage: lastDate,
            });
            if (written % 20 === 0) {
              context.logger.info(
                `Progress: ${written}/${filtered.length} conversations written`,
              );
            }
          } catch (e) {
            context.logger.warn(
              `Failed to write ${safeFile}: ${
                e instanceof Error ? e.message : String(e)
              }`,
            );
            skipped++;
          }
        }

        context.logger.info(`Done. Written: ${written}, Skipped: ${skipped}`);

        const summary = {
          historyDir: context.globalArgs.historyDir,
          totalConversations: written,
          totalDMs: conversations.filter((c) => c.chatType === "dm").length,
          totalConferences:
            conversations.filter((c) => c.chatType === "conference").length,
          totalMessages: conversations.reduce(
            (sum, c) => sum + c.messageCount,
            0,
          ),
          conversations,
          timestamp: new Date().toISOString(),
        };

        const handle = await context.writeResource(
          "summary",
          "import",
          summary,
        );
        return { dataHandles: [handle] };
      },
    },
  },
};
