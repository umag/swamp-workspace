import { z } from "npm:zod@4";

// Skype message database reader
// Reads SQLite main.db files from Skype profile directories

const GlobalArgsSchema = z.object({
  basePath: z.string().describe(
    "Path to Skype data directory (contains profile subdirectories)",
  ),
  profile: z.string().describe(
    "Profile directory name (e.g. your-skype-name)",
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

async function queryDb(
  dbPath: string,
  sql: string,
): Promise<string[][]> {
  const cmd = new Deno.Command("sqlite3", {
    args: ["-separator", "\t", dbPath, sql],
    stdout: "piped",
    stderr: "piped",
  });
  const output = await cmd.output();
  if (!output.success) {
    const err = new TextDecoder().decode(output.stderr);
    throw new Error(`SQLite error: ${err}`);
  }
  const text = new TextDecoder().decode(output.stdout).trim();
  if (!text) return [];
  return text.split("\n").map((line) => line.split("\t"));
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
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n)));
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
  version: "2026.07.16.2",
  globalArguments: GlobalArgsSchema,

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
        const convRows = await queryDb(
          dbPath,
          `SELECT id, identity, displayname FROM Conversations
           WHERE identity = '${args.conversation.replace(/'/g, "''")}'
              OR displayname = '${args.conversation.replace(/'/g, "''")}'
           LIMIT 1;`,
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

        const safeKey = convoName.replace(/[^a-zA-Z0-9а-яА-Я]/g, "_")
          .slice(0, 50);
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
        const needle = args.sender.replace(/'/g, "''");

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
        );

        context.logger.info(
          `Found ${convRows.length} conversations to export`,
        );

        const notes: Array<Record<string, unknown>> = [];

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
          );

          // Build frontmatter
          let md = "---\n";
          const safeName = displayname.replace(/"/g, '\\"');
          md += `title: "${safeName}"\n`;
          md += `type: ${typeName}\n`;
          md += `identity: "${identity.replace(/"/g, '\\"')}"\n`;
          md += `profile: "${profile}"\n`;
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

          // File name
          const safeFile = displayname
            .replace(/[\/\\:*?"<>|#%\[\]{}]/g, "-")
            .replace(/\.+$/, "")
            .trim()
            .slice(0, 80);
          const fileName = `${subfolder}/${safeFile}`;

          notes.push({
            obsidianPath: fileName,
            obsidianContent: md,
            displayname,
            messageCount: msgCount,
          });
        }

        context.logger.info(`Formatted ${notes.length} notes`);

        const handle = await context.writeResource(
          "messages",
          `obsidian_${profile}`,
          {
            profile,
            query: `obsidian:${profile}`,
            messages: notes,
            count: notes.length,
          },
        );
        return { dataHandles: [handle] };
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
          md += `title: "${displayname.replace(/"/g, '\\"')}"\n`;
          md += `type: ${typeName}\n`;
          md += `identity: "${identity.replace(/"/g, '\\"')}"\n`;
          md += `profile: "${profile}"\n`;
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

          // Write directly to vault directory
          const safeFile = displayname
            .replace(/[\/\\:*?"<>|#%\[\]{}]/g, "-")
            .replace(/\.+$/, "")
            .trim()
            .slice(0, 80);
          const noteDir = `${args.vaultPath}/${subfolder}`;
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
        const needle = args.text.replace(/'/g, "''");

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

        const textKey = args.text.slice(0, 20).replace(
          /[^a-zA-Z0-9]/g,
          "_",
        );
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
