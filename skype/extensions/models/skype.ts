import { z } from "npm:zod@4";
import { isAbsolute, relative, resolve } from "jsr:@std/path@1";

// Skype message database reader
// Reads SQLite main.db files from Skype profile directories

const GlobalArgsSchema = z.object({
  basePath: z.string().describe(
    "Path to Skype data directory (contains profile subdirectories)",
  ),
  profile: z.string().describe(
    "Profile directory name (e.g. your-skype-name)",
  ),
  queryTimeoutMs: z.number().default(30000).describe(
    "Max milliseconds to wait for a single sqlite3 subprocess query before aborting it",
  ),
});

const ConversationSchema = z.object({
  id: z.number(),
  identity: z.string(),
  displayname: z.string(),
  type: z.number(),
  messageCount: z.number().optional(),
  firstMessage: z.string().optional(),
  lastMessage: z.string().optional(),
}).passthrough();

const MessageSchema = z.object({
  id: z.number(),
  convoId: z.number(),
  author: z.string(),
  authorDisplay: z.string(),
  timestamp: z.number(),
  date: z.string(),
  type: z.number(),
  body: z.string(),
  chatname: z.string().optional(),
  dialogPartner: z.string().optional(),
}).passthrough();

const ContactSchema = z.object({
  id: z.number(),
  skypename: z.string(),
  fullname: z.string().optional(),
  city: z.string().optional(),
  country: z.string().optional(),
}).passthrough();

// --- SQLite helper via Deno Command ---

// sqlite3's "-separator" (TSV) list mode does NOT escape an embedded
// newline/tab byte inside a TEXT value, so a body_xml containing either one
// corrupts row/column framing (fabricated rows, shifted columns). "-ascii"
// mode instead frames columns with 0x1F (unit separator) and rows with 0x1E
// (record separator) -- bytes that never occur in ordinary text -- so the
// transport is lossless regardless of what the data contains.
const ASCII_UNIT_SEP = "\x1F";
const ASCII_RECORD_SEP = "\x1E";

// BUG #5 fix: queryDb used to construct Deno.Command with no signal/timeout
// option at all -- a wedged sqlite3 process (e.g. a locked/corrupt main.db)
// would hold the caller (and the swamp model lock) forever. An
// AbortController + setTimeout is used deliberately instead of the simpler
// `AbortSignal.timeout(ms)`: that built-in creates an internal timer with no
// handle the caller can clear, so a query that finishes well within its
// budget would still leave a live timer running until it eventually fires --
// under Deno's test resource sanitizer that shows up as a leaked timer. The
// explicit `clearTimeout` in `finally` guarantees the timer is torn down the
// instant the subprocess call settles, success or failure alike.
async function queryDb(
  dbPath: string,
  sql: string,
  timeoutMs = 30000,
): Promise<string[][]> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const cmd = new Deno.Command("sqlite3", {
      args: ["-ascii", dbPath, sql],
      stdout: "piped",
      stderr: "piped",
      signal: ac.signal,
    });
    const output = await cmd.output();
    if (!output.success) {
      const err = new TextDecoder().decode(output.stderr);
      throw new Error(`SQLite error: ${err}`);
    }
    const text = new TextDecoder().decode(output.stdout).trim();
    if (!text) return [];
    const records = text.split(ASCII_RECORD_SEP);
    // sqlite3 terminates EVERY record with 0x1E, including the last one, so a
    // naive split always leaves a trailing empty record -- drop it, or every
    // query fabricates one spurious blank row.
    if (records[records.length - 1] === "") records.pop();
    return records.map((record) => record.split(ASCII_UNIT_SEP));
  } finally {
    clearTimeout(timer);
  }
}

function stripXml(body: string): string {
  if (!body) return "";
  return body
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    // BUG #8 fix: String.fromCharCode only ever produces a SINGLE UTF-16 code
    // unit, so any astral (>0xFFFF) numeric entity -- e.g. &#128512; (the
    // grinning-face emoji) -- silently decoded to an unrelated BMP character
    // instead of the intended emoji. String.fromCodePoint handles the full
    // Unicode range correctly (encoding a surrogate pair when needed); the
    // range guard leaves an out-of-range code point (negative, or beyond
    // 0x10FFFF -- impossible for \d+ to produce a negative value, but
    // fromCodePoint throws RangeError above 0x10FFFF) as the original
    // entity text verbatim rather than throwing.
    .replace(/&#(\d+);/g, (match, n) => {
      const cp = parseInt(n, 10);
      return (cp >= 0 && cp <= 0x10ffff) ? String.fromCodePoint(cp) : match;
    });
}

/**
 * FNV-1a 32-bit hash of `s`, base36-encoded (BUG #3/#6 fix). Used by
 * {@linkcode truncKey} to disambiguate two distinct inputs that would
 * otherwise collide once both are truncated to the same prefix.
 */
export function shortHash(s: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    hash ^= s.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

/**
 * Truncate `s` to at most `n` CODE POINTS -- never splitting a surrogate pair
 * in half the way a raw `.slice(0, n)` can (BUG #6) -- and, only when
 * truncation actually removes something, append a short deterministic hash
 * of the FULL original string so two distinct inputs that happen to share
 * the same first `n` code points never collide on the same truncated key
 * (BUG #3). A string that already fits within `n` code points is returned
 * completely unchanged, so every existing short resource name / file name
 * stays byte-identical.
 */
export function truncKey(s: string, n: number): string {
  const codePoints = Array.from(s);
  if (codePoints.length <= n) return s;
  return codePoints.slice(0, n).join("") + "_" + shortHash(s);
}

/**
 * Escape `s` for embedding in a single-quoted SQL string literal by doubling
 * every `'`, and reject an embedded NUL byte outright (BUG #9 fix).
 * Centralizes the escape that used to be duplicated (identically) across
 * `readConversation`, `searchBySender`, and `searchByText`. The NUL check is
 * a hard boundary rather than an escape rule -- sqlite3's own C string
 * handling truncates a value at the first NUL, which a `'`-doubling replace
 * can never protect against.
 */
export function sqlString(s: string): string {
  if (s.includes("\x00")) {
    throw new Error(
      "SQL string literal must not contain a NUL byte (\\x00)",
    );
  }
  return s.replace(/'/g, "''");
}

/**
 * Escape `s` for use inside a YAML double-quoted scalar (BUG #7 fix):
 * backslash and double-quote are backslash-escaped, and every C0 control
 * character (including a raw CR/LF) is replaced with its escape sequence.
 * Used for title/identity/profile in `exportToObsidian`'s and
 * `importToObsidian`'s frontmatter so a hostile displayname/identity carrying
 * a raw line-break can no longer break out of the YAML string scalar and
 * inject an arbitrary additional frontmatter key.
 */
export function yamlDq(s: string): string {
  return s
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(
      // deno-lint-ignore no-control-regex
      /[\x00-\x1f]/g,
      (c) => {
        switch (c) {
          case "\n":
            return "\\n";
          case "\r":
            return "\\r";
          case "\t":
            return "\\t";
          default:
            return "\\x" + c.charCodeAt(0).toString(16).padStart(2, "0");
        }
      },
    );
}

// BUG #3/#6 fix: shared filename sanitizer for exportToObsidian and
// importToObsidian -- both derive an on-disk-safe note name from
// `displayname` via the identical replace/replace/trim pipeline, so it is
// factored out once. `truncKey` (not a raw `.slice`) both keeps a surrogate
// pair intact through the cut and disambiguates two names that only differ
// after it.
function safeFileName(displayname: string): string {
  const sanitized = displayname
    .replace(/[\/\\:*?"<>|#%\[\]{}]/g, "-")
    .replace(/\.+$/, "")
    .trim();
  return truncKey(sanitized, 80);
}

// Resolve `root` joined with `segments` and reject any result that escapes
// `root` -- e.g. a `folder` or `profile` argument containing "../" or an
// absolute override. Lexical resolution does not follow symlinks: a
// pre-existing symlink inside the vault pointing outward could still let a
// write escape (residual, acceptable for this local-user threat model -- see
// CHANGELOG). This module joins paths with "/" throughout (POSIX-only), so
// the containment check is POSIX-only too, matching the rest of the file.
function resolveWithin(root: string, ...segments: string[]): string {
  const target = resolve(root, ...segments);
  const rel = relative(root, target);
  if (rel === ".." || rel.startsWith("../") || isAbsolute(rel)) {
    throw new Error(
      `Refusing to write outside vault: '${
        segments.join("/")
      }' resolves to '${target}', which escapes '${root}'`,
    );
  }
  return target;
}

function tsToIso(ts: string | number): string {
  const n = typeof ts === "string" ? parseInt(ts) : ts;
  if (!n || isNaN(n) || n <= 0 || n > 4102444800) return "";
  try {
    return new Date(n * 1000).toISOString();
  } catch {
    return "";
  }
}

// --- Model ---

/** Swamp model that reads a Skype SQLite `main.db` to list profiles, conversations and contacts, search messages, and export chat logs to Obsidian notes. */
export const model = {
  type: "@magistr/skype",
  version: "2026.08.02.1",
  globalArguments: GlobalArgsSchema,

  upgrades: [
    {
      fromVersion: "2026.08.01.1",
      toVersion: "2026.08.02.1",
      description:
        "LB3–LB9 fixes; adds queryTimeoutMs global arg (defaulted) + exportToObsidian maxNotesPerResource method arg; no resource-schema change",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
  ],

  resources: {
    conversations: {
      description: "List of Skype conversations",
      schema: z.object({
        profile: z.string(),
        conversations: z.array(ConversationSchema),
        count: z.number(),
      }),
      lifetime: "infinite",
      garbageCollection: 5,
    },
    messages: {
      description: "Messages from a conversation or search",
      schema: z.object({
        profile: z.string(),
        query: z.string().optional(),
        conversation: z.string().optional(),
        messages: z.array(MessageSchema),
        count: z.number(),
      }),
      lifetime: "1h",
      garbageCollection: 10,
    },
    contacts: {
      description: "Contacts list",
      schema: z.object({
        profile: z.string(),
        contacts: z.array(ContactSchema),
        count: z.number(),
      }),
      lifetime: "infinite",
      garbageCollection: 5,
    },
  },

  methods: {
    listProfiles: {
      description: "List available Skype profiles in the data directory",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const basePath = context.globalArgs.basePath;
        const profiles: string[] = [];
        for await (const entry of Deno.readDir(basePath)) {
          if (!entry.isDirectory) continue;
          try {
            await Deno.stat(`${basePath}/${entry.name}/main.db`);
            profiles.push(entry.name);
          } catch {
            // no main.db
          }
        }

        const handle = await context.writeResource(
          "conversations",
          "profiles",
          {
            profile: "all",
            conversations: profiles.map((p, i) => ({
              id: i,
              identity: p,
              displayname: p,
              type: 0,
            })),
            count: profiles.length,
          },
        );
        return { dataHandles: [handle] };
      },
    },

    listConversations: {
      description:
        "List all conversations with message counts, ordered by activity",
      arguments: z.object({
        minMessages: z.number().default(1).describe(
          "Minimum messages to include",
        ),
      }),
      execute: async (args, context) => {
        const dbPath =
          `${context.globalArgs.basePath}/${context.globalArgs.profile}/main.db`;

        const rows = await queryDb(
          dbPath,
          `SELECT c.id, c.identity, c.displayname, c.type,
                  COUNT(m.id) as msg_count,
                  MIN(m.timestamp) as first_ts,
                  MAX(m.timestamp) as last_ts
           FROM Conversations c
           LEFT JOIN Messages m ON m.convo_id = c.id AND m.type = 61
           GROUP BY c.id
           HAVING msg_count >= ${args.minMessages}
           ORDER BY last_ts DESC;`,
          context.globalArgs.queryTimeoutMs,
        );

        const conversations = rows.map((r) => ({
          id: parseInt(r[0]),
          identity: r[1] || "",
          displayname: r[2] || r[1] || "",
          type: parseInt(r[3] || "0"),
          messageCount: parseInt(r[4] || "0"),
          firstMessage: tsToIso(r[5]),
          lastMessage: tsToIso(r[6]),
        }));

        const handle = await context.writeResource(
          "conversations",
          "conv_list",
          {
            profile: context.globalArgs.profile,
            conversations,
            count: conversations.length,
          },
        );
        return { dataHandles: [handle] };
      },
    },

    listContacts: {
      description: "List all contacts",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const dbPath =
          `${context.globalArgs.basePath}/${context.globalArgs.profile}/main.db`;

        const rows = await queryDb(
          dbPath,
          `SELECT id, skypename, fullname, city, country
           FROM Contacts
           WHERE is_permanent = 1
           ORDER BY fullname;`,
          context.globalArgs.queryTimeoutMs,
        );

        const contacts = rows.map((r) => ({
          id: parseInt(r[0]),
          skypename: r[1] || "",
          fullname: r[2] || "",
          city: r[3] || "",
          country: r[4] || "",
        }));

        const handle = await context.writeResource(
          "contacts",
          "contact_list",
          {
            profile: context.globalArgs.profile,
            contacts,
            count: contacts.length,
          },
        );
        return { dataHandles: [handle] };
      },
    },

    readConversation: {
      description: "Read messages from a specific conversation",
      arguments: z.object({
        conversation: z.string().describe(
          "Conversation identity or display name",
        ),
        limit: z.number().default(500).describe("Max messages"),
        offset: z.number().default(0).describe("Skip first N messages"),
      }),
      execute: async (args, context) => {
        const dbPath =
          `${context.globalArgs.basePath}/${context.globalArgs.profile}/main.db`;

        // Find conversation by identity or displayname
        const safeConversation = sqlString(args.conversation);
        const convRows = await queryDb(
          dbPath,
          `SELECT id, identity, displayname FROM Conversations
           WHERE identity = '${safeConversation}'
              OR displayname = '${safeConversation}'
           LIMIT 1;`,
          context.globalArgs.queryTimeoutMs,
        );

        if (convRows.length === 0) {
          throw new Error(
            `Conversation '${args.conversation}' not found`,
          );
        }

        const convoId = convRows[0][0];
        const convoName = convRows[0][2] || convRows[0][1];

        const rows = await queryDb(
          dbPath,
          `SELECT id, convo_id, author, from_dispname, timestamp, type,
                  body_xml, chatname, dialog_partner
           FROM Messages
           WHERE convo_id = ${convoId} AND type = 61 AND body_xml IS NOT NULL
           ORDER BY timestamp ASC
           LIMIT ${args.limit} OFFSET ${args.offset};`,
          context.globalArgs.queryTimeoutMs,
        );

        const messages = rows.map((r) => ({
          id: parseInt(r[0]),
          convoId: parseInt(r[1]),
          author: r[2] || "",
          authorDisplay: r[3] || r[2] || "",
          timestamp: parseInt(r[4] || "0"),
          date: tsToIso(r[4]),
          type: parseInt(r[5] || "0"),
          body: stripXml(r[6] || ""),
          chatname: r[7] || "",
          dialogPartner: r[8] || "",
        }));

        // BUG #3 fix: truncKey (not a raw .slice(0, 50)) appends a hash of
        // the FULL conversation name once truncation actually occurs, so two
        // distinct conversations sharing the same 50-char sanitized prefix
        // no longer collide on the identical conv_<safeKey> resource name.
        const safeKeyFull = convoName.replace(/[^a-zA-Z0-9а-яА-Я]/g, "_");
        const safeKey = truncKey(safeKeyFull, 50);
        const handle = await context.writeResource(
          "messages",
          `conv_${safeKey}`,
          {
            profile: context.globalArgs.profile,
            conversation: convoName,
            messages,
            count: messages.length,
          },
        );
        return { dataHandles: [handle] };
      },
    },

    searchBySender: {
      description:
        "Search all conversations for messages from a specific sender",
      arguments: z.object({
        sender: z.string().describe(
          "Sender skypename or display name (partial match)",
        ),
        limit: z.number().default(200).describe("Max results"),
      }),
      execute: async (args, context) => {
        const dbPath =
          `${context.globalArgs.basePath}/${context.globalArgs.profile}/main.db`;
        const needle = sqlString(args.sender);

        const rows = await queryDb(
          dbPath,
          `SELECT m.id, m.convo_id, m.author, m.from_dispname, m.timestamp,
                  m.type, m.body_xml, m.chatname, m.dialog_partner,
                  c.displayname
           FROM Messages m
           JOIN Conversations c ON c.id = m.convo_id
           WHERE m.type = 61 AND m.body_xml IS NOT NULL
             AND (m.author LIKE '%${needle}%' OR m.from_dispname LIKE '%${needle}%')
           ORDER BY m.timestamp ASC
           LIMIT ${args.limit};`,
          context.globalArgs.queryTimeoutMs,
        );

        const messages = rows.map((r) => ({
          id: parseInt(r[0]),
          convoId: parseInt(r[1]),
          author: r[2] || "",
          authorDisplay: r[3] || r[2] || "",
          timestamp: parseInt(r[4] || "0"),
          date: tsToIso(r[4]),
          type: parseInt(r[5] || "0"),
          body: stripXml(r[6] || ""),
          chatname: r[7] || "",
          dialogPartner: r[8] || "",
          conversationName: r[9] || "",
        }));

        const senderKey = args.sender.replace(/[^a-zA-Z0-9]/g, "_");
        const handle = await context.writeResource(
          "messages",
          `sender_${senderKey}`,
          {
            profile: context.globalArgs.profile,
            query: `sender:${args.sender}`,
            messages,
            count: messages.length,
          },
        );
        return { dataHandles: [handle] };
      },
    },

    exportToObsidian: {
      description:
        "Export all conversations as Obsidian notes — one note per conversation with full chat log",
      arguments: z.object({
        folder: z.string().default("Skype").describe(
          "Obsidian base folder",
        ),
        minMessages: z.number().default(1).describe(
          "Skip conversations with fewer messages",
        ),
        maxNotesPerResource: z.number().default(500).describe(
          "Flush accumulated notes to a new data resource after this many conversations, bounding both in-memory growth and per-resource size for large profiles",
        ),
      }),
      execute: async (args, context) => {
        const dbPath =
          `${context.globalArgs.basePath}/${context.globalArgs.profile}/main.db`;
        const profile = context.globalArgs.profile;
        const subfolder = `${args.folder}/${profile}`;

        // Get all conversations
        const convRows = await queryDb(
          dbPath,
          `SELECT c.id, c.identity, c.displayname, c.type,
                  COUNT(m.id) as msg_count,
                  MIN(m.timestamp) as first_ts,
                  MAX(m.timestamp) as last_ts
           FROM Conversations c
           JOIN Messages m ON m.convo_id = c.id AND m.type = 61 AND m.body_xml IS NOT NULL
           GROUP BY c.id
           HAVING msg_count >= ${args.minMessages}
           ORDER BY last_ts DESC;`,
          context.globalArgs.queryTimeoutMs,
        );

        context.logger.info(
          `Found ${convRows.length} conversations to export`,
        );

        // BUG #4 fix: exportToObsidian used to accumulate EVERY conversation's
        // full chat log into one in-memory array and write it as exactly one
        // writeResource call, unbounded regardless of profile size. `notes`
        // is now flushed to its own data resource every `maxNotesPerResource`
        // conversations and reset; `handles` collects every page written.
        // Page 0 keeps the original `obsidian_<profile>` name (so any
        // profile within the default 500-conversation budget, which is every
        // fixture in this test suite, still writes exactly one
        // byte-identical resource); overflow pages are numbered
        // `obsidian_<profile>_p<N>`. The buffer is always flushed once more
        // after the loop UNLESS it is empty and at least one page has
        // already been written — an empty export must still produce exactly
        // one (empty) page 0, never zero resources.
        let notes: Array<Record<string, unknown>> = [];
        const handles: unknown[] = [];
        let page = 0;
        let totalNotes = 0;

        const flush = async () => {
          const resourceName = page === 0
            ? `obsidian_${profile}`
            : `obsidian_${profile}_p${page}`;
          const handle = await context.writeResource(
            "messages",
            resourceName,
            {
              profile,
              query: `obsidian:${profile}`,
              messages: notes,
              count: notes.length,
            },
          );
          handles.push(handle);
          notes = [];
          page++;
        };

        for (const conv of convRows) {
          const convoId = conv[0];
          const identity = conv[1] || "";
          const displayname = conv[2] || identity;
          const convoType = parseInt(conv[3] || "0");
          const msgCount = parseInt(conv[4] || "0");
          const firstTs = conv[5];
          const lastTs = conv[6];
          const firstDate = tsToIso(firstTs).slice(0, 10);
          const lastDate = tsToIso(lastTs).slice(0, 10);
          const typeName = convoType === 2 ? "group" : "direct";

          // Fetch all messages for this conversation
          const msgRows = await queryDb(
            dbPath,
            `SELECT from_dispname, author, timestamp, body_xml
             FROM Messages
             WHERE convo_id = ${convoId} AND type = 61 AND body_xml IS NOT NULL
             ORDER BY timestamp ASC;`,
            context.globalArgs.queryTimeoutMs,
          );

          // Build frontmatter. BUG #7 fix: title/identity/profile now go
          // through yamlDq (backslash + quote + every C0 control, including
          // a raw CR/LF, all escaped) instead of only ever escaping a quote
          // -- a displayname carrying a raw line-break used to break out of
          // the YAML string scalar and inject arbitrary additional
          // frontmatter lines.
          let md = "---\n";
          md += `title: "${yamlDq(displayname)}"\n`;
          md += `type: ${typeName}\n`;
          md += `identity: "${yamlDq(identity)}"\n`;
          md += `profile: "${yamlDq(profile)}"\n`;
          md += `messages: ${msgCount}\n`;
          md += `first_message: ${firstDate}\n`;
          md += `last_message: ${lastDate}\n`;
          md += "tags:\n  - skype\n";
          md += `  - skype-${typeName}\n`;
          md += "---\n\n";

          // Build chat log
          let currentDate = "";
          for (const mr of msgRows) {
            const sender = mr[0] || mr[1] || "?";
            const ts = parseInt(mr[2] || "0");
            const body = stripXml(mr[3] || "");
            if (!body.trim()) continue;

            if (!ts || isNaN(ts) || ts <= 0 || ts > 4102444800) continue;
            let dateStr: string;
            let timeStr: string;
            try {
              const dt = new Date(ts * 1000);
              dateStr = dt.toISOString().slice(0, 10);
              timeStr = dt.toISOString().slice(11, 16);
            } catch {
              continue;
            }

            if (dateStr !== currentDate) {
              md += `\n### ${dateStr}\n\n`;
              currentDate = dateStr;
            }

            md += `**${timeStr} ${sender}:** ${body}\n\n`;
          }

          // File name — BUG #3/#6 fix: safeFileName truncates by CODE POINT
          // (never splitting a surrogate pair) and appends a hash past the
          // cut so two distinct names sharing the same 80-char prefix no
          // longer collide on the identical obsidianPath.
          const safeFile = safeFileName(displayname);
          const fileName = `${subfolder}/${safeFile}`;

          notes.push({
            obsidianPath: fileName,
            obsidianContent: md,
            displayname,
            messageCount: msgCount,
          });
          totalNotes++;

          if (notes.length >= args.maxNotesPerResource) {
            await flush();
          }
        }

        if (notes.length > 0 || page === 0) {
          await flush();
        }

        context.logger.info(
          `Formatted ${totalNotes} notes across ${page} page(s)`,
        );

        return { dataHandles: handles };
      },
    },

    importToObsidian: {
      description:
        "Export all conversations and write to Obsidian vault via CLI — handles large conversations",
      arguments: z.object({
        folder: z.string().default("Skype").describe(
          "Obsidian base folder",
        ),
        vaultPath: z.string().describe(
          "Absolute path to Obsidian vault directory",
        ),
        minMessages: z.number().default(1).describe(
          "Skip conversations with fewer messages",
        ),
      }),
      execute: async (args, context) => {
        const dbPath =
          `${context.globalArgs.basePath}/${context.globalArgs.profile}/main.db`;
        const profile = context.globalArgs.profile;

        // Get all conversations
        const convRows = await queryDb(
          dbPath,
          `SELECT c.id, c.identity, c.displayname, c.type,
                  COUNT(m.id) as msg_count,
                  MIN(m.timestamp) as first_ts,
                  MAX(m.timestamp) as last_ts
           FROM Conversations c
           JOIN Messages m ON m.convo_id = c.id AND m.type = 61 AND m.body_xml IS NOT NULL
           GROUP BY c.id
           HAVING msg_count >= ${args.minMessages}
           ORDER BY last_ts DESC;`,
          context.globalArgs.queryTimeoutMs,
        );

        context.logger.info(
          `Found ${convRows.length} conversations to import`,
        );

        let written = 0;
        let skipped = 0;

        for (const conv of convRows) {
          const convoId = conv[0];
          const identity = conv[1] || "";
          const displayname = conv[2] || identity;
          const convoType = parseInt(conv[3] || "0");
          const msgCount = parseInt(conv[4] || "0");
          const firstTs = conv[5];
          const lastTs = conv[6];
          const firstDate = tsToIso(firstTs).slice(0, 10) || "unknown";
          const lastDate = tsToIso(lastTs).slice(0, 10) || "unknown";
          const typeName = convoType === 2 ? "group" : "direct";

          // Fetch messages in chunks to handle large conversations
          const chunkSize = 10000;
          let offset = 0;
          let md = "---\n";
          // BUG #7 fix: yamlDq (backslash + quote + every C0 control,
          // including a raw CR/LF) replaces the quote-only escape — see
          // exportToObsidian's identical fix for the full rationale.
          md += `title: "${yamlDq(displayname)}"\n`;
          md += `type: ${typeName}\n`;
          md += `identity: "${yamlDq(identity)}"\n`;
          md += `profile: "${yamlDq(profile)}"\n`;
          md += `messages: ${msgCount}\n`;
          md += `first_message: ${firstDate}\n`;
          md += `last_message: ${lastDate}\n`;
          md += "tags:\n  - skype\n";
          md += `  - skype-${typeName}\n`;
          md += "---\n\n";

          let currentDate = "";

          while (true) {
            const msgRows = await queryDb(
              dbPath,
              `SELECT from_dispname, author, timestamp, body_xml
               FROM Messages
               WHERE convo_id = ${convoId} AND type = 61 AND body_xml IS NOT NULL
               ORDER BY timestamp ASC
               LIMIT ${chunkSize} OFFSET ${offset};`,
              context.globalArgs.queryTimeoutMs,
            );

            if (msgRows.length === 0) break;

            for (const mr of msgRows) {
              const sender = mr[0] || mr[1] || "?";
              const ts = parseInt(mr[2] || "0");
              const body = stripXml(mr[3] || "");
              if (!body.trim()) continue;
              if (!ts || isNaN(ts) || ts <= 0 || ts > 4102444800) continue;

              let dateStr: string;
              let timeStr: string;
              try {
                const dt = new Date(ts * 1000);
                dateStr = dt.toISOString().slice(0, 10);
                timeStr = dt.toISOString().slice(11, 16);
              } catch {
                continue;
              }

              if (dateStr !== currentDate) {
                md += `\n### ${dateStr}\n\n`;
                currentDate = dateStr;
              }

              md += `**${timeStr} ${sender}:** ${body}\n\n`;
            }

            offset += chunkSize;
            if (msgRows.length < chunkSize) break;
          }

          // Write directly to vault directory. BUG #3/#6 fix: safeFileName
          // truncates by CODE POINT (never splitting a surrogate pair, so an
          // astral emoji near the cut survives intact rather than being
          // silently corrupted to U+FFFD on disk) and appends a hash past
          // the cut so two distinct names sharing the same 80-char prefix no
          // longer overwrite each other's note.
          const safeFile = safeFileName(displayname);
          // Guard the write boundary: folder AND profile are both
          // attacker-influenced (BUG #2 -- path traversal), so both must be
          // contained inside vaultPath before anything is written.
          const noteDir = resolveWithin(args.vaultPath, args.folder, profile);
          const notePath = `${noteDir}/${safeFile}.md`;

          try {
            await Deno.mkdir(noteDir, { recursive: true });
            await Deno.writeTextFile(notePath, md);
            written++;
            if (written % 20 === 0) {
              context.logger.info(
                `Progress: ${written}/${convRows.length} conversations written`,
              );
            }
          } catch (e) {
            const message = e instanceof Error ? e.message : String(e);
            context.logger.warn(
              `Failed to write ${safeFile}: ${message}`,
            );
            skipped++;
          }
        }

        context.logger.info(
          `Done. Written: ${written}, Skipped: ${skipped}`,
        );

        const handle = await context.writeResource(
          "conversations",
          `import_${profile}`,
          {
            profile,
            conversations: convRows.map((r) => ({
              id: parseInt(r[0]),
              identity: r[1] || "",
              displayname: r[2] || r[1] || "",
              type: parseInt(r[3] || "0"),
              messageCount: parseInt(r[4] || "0"),
              firstMessage: tsToIso(r[5]),
              lastMessage: tsToIso(r[6]),
            })),
            count: written,
          },
        );
        return { dataHandles: [handle] };
      },
    },

    searchByText: {
      description: "Search all messages for text content",
      arguments: z.object({
        text: z.string().describe("Text to search for"),
        limit: z.number().default(200).describe("Max results"),
      }),
      execute: async (args, context) => {
        const dbPath =
          `${context.globalArgs.basePath}/${context.globalArgs.profile}/main.db`;
        const needle = sqlString(args.text);

        const rows = await queryDb(
          dbPath,
          `SELECT m.id, m.convo_id, m.author, m.from_dispname, m.timestamp,
                  m.type, m.body_xml, m.chatname, m.dialog_partner,
                  c.displayname
           FROM Messages m
           JOIN Conversations c ON c.id = m.convo_id
           WHERE m.type = 61 AND m.body_xml LIKE '%${needle}%'
           ORDER BY m.timestamp ASC
           LIMIT ${args.limit};`,
          context.globalArgs.queryTimeoutMs,
        );

        const messages = rows.map((r) => ({
          id: parseInt(r[0]),
          convoId: parseInt(r[1]),
          author: r[2] || "",
          authorDisplay: r[3] || r[2] || "",
          timestamp: parseInt(r[4] || "0"),
          date: tsToIso(r[4]),
          type: parseInt(r[5] || "0"),
          body: stripXml(r[6] || ""),
          chatname: r[7] || "",
          dialogPartner: r[8] || "",
          conversationName: r[9] || "",
        }));

        // BUG #6 fix (folded into LB3's truncKey): sanitize first, THEN
        // truncate by CODE POINT — a raw `.slice(0, 20)` executed BEFORE
        // sanitizing could cut an astral character's surrogate pair in
        // half. For any all-ASCII search term this produces the identical
        // key as before (sanitizing is a position-preserving 1:1 map, so
        // slice-then-replace and replace-then-slice agree whenever no
        // multi-code-unit character falls within the window).
        const textKeyFull = args.text.replace(/[^a-zA-Z0-9]/g, "_");
        const textKey = truncKey(textKeyFull, 20);
        const handle = await context.writeResource(
          "messages",
          `search_${textKey}`,
          {
            profile: context.globalArgs.profile,
            query: `text:${args.text}`,
            messages,
            count: messages.length,
          },
        );
        return { dataHandles: [handle] };
      },
    },
  },
};
