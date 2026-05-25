import { z } from "npm:zod@4";

const GlobalArgsSchema = z.object({
  zipPath: z.string().describe("Path to Telegram channel export zip file"),
  vault: z.string().describe("Obsidian vault name"),
  folder: z.string().default("Telegram").describe(
    "Target folder in Obsidian vault for imported notes",
  ),
  attachmentsFolder: z.string().default("attachments").describe(
    "Attachments folder name inside the target folder",
  ),
});

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
 * Telegram channel export importer model: parses a Telegram JSON export zip and
 * writes posts, images, files, and videos into an Obsidian vault.
 */
export const model = {
  type: "@magistr/telegram/import",
  version: "2026.03.28.2",
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
  ],
  methods: {
    import: {
      description:
        "Parse Telegram export zip and import posts with images into Obsidian vault",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const { zipPath, vault, folder, attachmentsFolder } =
          context.globalArgs;
        const logger = context.logger;

        // Extract zip to temp directory
        const tmpDir = await Deno.makeTempDir({ prefix: "telegram-import-" });

        try {
          const unzipProc = new Deno.Command("unzip", {
            args: ["-o", zipPath, "-d", tmpDir],
            stdout: "piped",
            stderr: "piped",
          });
          const unzipOut = await unzipProc.output();
          if (!unzipOut.success) {
            const stderr = new TextDecoder().decode(unzipOut.stderr);
            throw new Error(`unzip failed: ${stderr}`);
          }

          // Find result.json in extracted dir
          const findProc = new Deno.Command("find", {
            args: [tmpDir, "-name", "result.json", "-type", "f"],
            stdout: "piped",
          });
          const findOut = await findProc.output();
          const resultPath = new TextDecoder()
            .decode(findOut.stdout)
            .trim()
            .split("\n")[0];
          if (!resultPath) {
            throw new Error("No result.json found in zip archive");
          }

          const extractDir = resultPath.replace("/result.json", "");
          const rawJson = await Deno.readTextFile(resultPath);
          const data = JSON.parse(rawJson);
          const channelName = data.name;

          // Filter actual messages (skip service messages)
          const messages = data.messages.filter((m) => m.type === "message");

          logger
            .info`Parsing ${messages.length} messages from channel "${channelName}"`;

          // Resolve vault path for copying binary files
          const vaultPath = await getVaultPath(vault);
          const attachFolder = `${folder}/${attachmentsFolder}`;
          const attachDiskPath = `${vaultPath}/${attachFolder}`;
          await Deno.mkdir(attachDiskPath, { recursive: true });

          const errors: string[] = [];
          let notesCreated = 0;
          let imagesCopied = 0;
          let filesCopied = 0;
          const dataHandles: unknown[] = [];

          for (const msg of messages) {
            const slug = noteSlug(msg);
            const text = telegramTextToMarkdown(msg.text);
            const date = msg.date;
            const msgId = msg.id;

            // Build frontmatter
            const fm = [
              "---",
              `title: "Post ${msgId}"`,
              `date: ${date}`,
              `source: telegram`,
              `channel: "${channelName}"`,
              `telegram_id: ${msgId}`,
            ];
            if (msg.forwarded_from) {
              fm.push(`forwarded_from: "${msg.forwarded_from}"`);
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

            // Handle photo
            let photoFilename;
            if (msg.photo) {
              const srcFile = `${extractDir}/${msg.photo}`;
              photoFilename = msg.photo.split("/").pop();
              try {
                await Deno.copyFile(
                  srcFile,
                  `${attachDiskPath}/${photoFilename}`,
                );
                imagesCopied++;
                body.push(`![[${attachFolder}/${photoFilename}]]`, "");
              } catch (e) {
                errors.push(
                  `Failed to copy image ${photoFilename}: ${
                    e instanceof Error ? e.message : String(e)
                  }`,
                );
              }
            }

            // Handle file attachment (PDF etc) — skip thumbnails and videos handled below
            if (
              msg.file &&
              typeof msg.file === "string" &&
              msg.media_type !== "video_file"
            ) {
              const fileName = msg.file.split("/").pop();
              if (!fileName.endsWith("_thumb.jpg")) {
                const srcFile = `${extractDir}/${msg.file}`;
                try {
                  await Deno.copyFile(
                    srcFile,
                    `${attachDiskPath}/${fileName}`,
                  );
                  filesCopied++;
                  body.push(`![[${attachFolder}/${fileName}]]`, "");
                } catch (e) {
                  errors.push(
                    `Failed to copy file ${fileName}: ${
                      e instanceof Error ? e.message : String(e)
                    }`,
                  );
                }
              }
            }

            // Handle video
            if (msg.media_type === "video_file" && msg.file) {
              const fileName = msg.file.split("/").pop();
              const srcFile = `${extractDir}/${msg.file}`;
              try {
                await Deno.copyFile(
                  srcFile,
                  `${attachDiskPath}/${fileName}`,
                );
                filesCopied++;
                body.push(`![[${attachFolder}/${fileName}]]`, "");
              } catch (e) {
                errors.push(
                  `Failed to copy video ${fileName}: ${
                    e instanceof Error ? e.message : String(e)
                  }`,
                );
              }
            }

            // Create the note via obsidian CLI
            const noteContent = fm.join("\n") + body.join("\n");
            const notePath = `${folder}/${slug}`;

            try {
              const noteKey = notePath.includes("/") ? "path" : "name";
              await runObsidian(
                "create",
                { [noteKey]: notePath, content: noteContent },
                vault,
                ["overwrite"],
              );
              notesCreated++;
            } catch (e) {
              errors.push(
                `Failed to create note ${notePath}: ${
                  e instanceof Error ? e.message : String(e)
                }`,
              );
            }

            // Write post resource (factory pattern)
            const postHandle = await context.writeResource("post", slug, {
              id: msgId,
              date,
              text: text.substring(0, 500),
              photo: photoFilename,
              forwardedFrom: msg.forwarded_from || undefined,
              replyTo: msg.reply_to_message_id || undefined,
              timestamp: new Date().toISOString(),
            });
            dataHandles.push(postHandle);
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
