import { z } from "npm:zod@4";

const GlobalArgsSchema = z.object({
  historyDir: z.string().describe(
    "Path to Psi/Psi+ Jabber client history directory (containing .history and conference log files)",
  ),
});

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
  return decodeURIComponent(filename.replace(/_at_/g, "@"));
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

async function getVaultPath(vault: string): Promise<string> {
  const proc = new Deno.Command("obsidian", {
    args: ["vault", `vault=${vault}`, "info=path"],
    stdout: "piped",
    stderr: "piped",
  });
  const output = await proc.output();
  if (!output.success) {
    const stderr = new TextDecoder().decode(output.stderr).trim();
    throw new Error(`Failed to resolve vault path: ${stderr}`);
  }
  return new TextDecoder().decode(output.stdout).trim();
}

function sanitizeFilename(jid: string): string {
  return jid
    .replace(/[\/\\:*?"<>|#%\[\]{}]/g, "-")
    .replace(/\.+$/, "")
    .trim()
    .slice(0, 80);
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
  version: "2026.03.29.3",
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
          const content = await Deno.readTextFile(file.path);

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
          const content = await Deno.readTextFile(file.path);
          let messages: Array<{
            timestamp: string;
            direction: string;
            sender?: string;
            body: string;
            flags?: string;
          }>;

          if (file.format === "pipe") {
            messages = parsePipeDelimited(content);
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
          const content = await Deno.readTextFile(file.path);

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
          "Direct filesystem path to the Obsidian vault (skips CLI resolution)",
        ),
        folder: z.string().default("Jabber").describe(
          "Target folder inside the vault",
        ),
        chatType: z.enum(["all", "dm", "conference"]).default("all").describe(
          "Filter by conversation type",
        ),
      }),
      execute: async (args, context) => {
        if (!args.vault && !args.vaultPath) {
          throw new Error("Either 'vault' or 'vaultPath' must be provided");
        }
        const vaultPath = args.vaultPath || await getVaultPath(args.vault!);
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

        const noteDir = `${vaultPath}/${args.folder}`;
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

        for (const file of filtered) {
          const content = await Deno.readTextFile(file.path);
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
            md += `title: "${file.jid.replace(/"/g, '\\"')}"\n`;
            md += `type: ${typeTag}\n`;
            md += `jid: "${file.jid}"\n`;
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
              const arrow = msg.direction === "to" ? "\u2192" : "\u2190";
              md += `**${timeStr} ${arrow}** ${msg.body}\n\n`;
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
            md += `title: "${file.jid.replace(/"/g, '\\"')}"\n`;
            md += `type: conference\n`;
            md += `jid: "${file.jid}"\n`;
            if (file.account) md += `account: "${file.account}"\n`;
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
              md += `**${timeStr} ${msg.sender}:** ${msg.body}\n\n`;
            }
          }

          const safeFile = sanitizeFilename(file.jid);
          const notePath = `${noteDir}/${safeFile}.md`;

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
