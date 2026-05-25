import { z } from "npm:zod@4";

const GlobalArgsSchema = z.object({
  vault: z.string().describe("Obsidian vault name"),
});

const NoteSchema = z.object({
  file: z.string(),
  content: z.string(),
  timestamp: z.iso.datetime(),
});

const FileInfoSchema = z.object({
  path: z.string(),
  name: z.string(),
  extension: z.string(),
  size: z.number(),
  created: z.number(),
  modified: z.number(),
  timestamp: z.iso.datetime(),
});

const NotesSchema = z.object({
  files: z.array(z.string()),
  count: z.number(),
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
  message: z.string().optional(),
  timestamp: z.iso.datetime(),
});

// Run an obsidian CLI command and return stdout as text
async function runObsidian(
  command: string,
  params: Record<string, string>,
  vault: string,
  bareFlags: string[] | undefined = undefined,
) {
  const args = [command];
  if (vault) {
    args.push(`vault=${vault}`);
  }
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
  const stdout = new TextDecoder().decode(output.stdout).trim();
  const stderr = new TextDecoder().decode(output.stderr).trim();

  if (!output.success) {
    throw new Error(
      `obsidian ${command} failed (exit ${output.code}): ${stderr || stdout}`,
    );
  }

  return stdout;
}

// Run command with format=json and parse the result
async function runObsidianJson(
  command: string,
  params: Record<string, string>,
  vault: string,
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

// Parse plain-text line-per-item output into string array
function parseLines(stdout: string): string[] {
  if (!stdout) return [];
  return stdout.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
}

// Parse TSV output into key-value objects
function parseTsv(stdout: string): Record<string, string> {
  if (!stdout) return {};
  const result: Record<string, string> = {};
  for (const line of stdout.split("\n")) {
    const [key, ...rest] = line.split("\t");
    if (key) result[key.trim()] = rest.join("\t").trim();
  }
  return result;
}

// Resolve file= vs path= depending on whether the name contains /
function fileParam(file: string): Record<string, string> {
  return file.includes("/") ? { path: file } : { file };
}

/** Obsidian vault model: manage notes, search, tags, links, daily notes, and frontmatter properties through the official Obsidian CLI. */
export const model = {
  type: "@magistr/obsidian/vault",
  version: "2026.03.28.2",
  upgrades: [
    {
      fromVersion: "2026.03.28.1",
      toVersion: "2026.03.28.2",
      description:
        "Fix CLI output parsing to match actual Obsidian CLI responses",
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
      description: "File metadata (size, timestamps)",
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
  },
  methods: {
    // --- File Operations ---

    list: {
      description: "List all notes in the vault",
      arguments: z.object({
        folder: z.string().optional().describe("Filter by folder path"),
        ext: z.string().optional().describe("Filter by extension (e.g. 'md')"),
      }),
      execute: async (args, context) => {
        // `files` does not support format=json — returns plain text lines
        const params: Record<string, string> = {};
        if (args.folder) params.folder = args.folder;
        if (args.ext) params.ext = args.ext;
        const stdout = await runObsidian(
          "files",
          params,
          context.globalArgs.vault,
        );
        const files = parseLines(stdout);
        const handle = await context.writeResource("notes", "main", {
          files,
          count: files.length,
          timestamp: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    read: {
      description: "Read a note's content",
      arguments: z.object({
        file: z.string().describe("Path to note (e.g. 'folder/note.md')"),
      }),
      execute: async (args, context) => {
        // `read` returns raw text, no JSON support
        const stdout = await runObsidian(
          "read",
          fileParam(args.file),
          context.globalArgs.vault,
        );
        const handle = await context.writeResource(
          "note",
          args.file.replace(/[/\\]/g, "_"),
          {
            file: args.file,
            content: stdout,
            timestamp: new Date().toISOString(),
          },
        );
        return { dataHandles: [handle] };
      },
    },

    fileInfo: {
      description: "Show file metadata (size, created, modified)",
      arguments: z.object({
        file: z.string().describe("Path to note"),
      }),
      execute: async (args, context) => {
        // `file` returns TSV key-value pairs, no JSON support
        const stdout = await runObsidian(
          "file",
          fileParam(args.file),
          context.globalArgs.vault,
        );
        const info = parseTsv(stdout);
        const handle = await context.writeResource(
          "fileInfo",
          args.file.replace(/[/\\]/g, "_"),
          {
            path: info.path || args.file,
            name: info.name || "",
            extension: info.extension || "",
            size: Number(info.size) || 0,
            created: Number(info.created) || 0,
            modified: Number(info.modified) || 0,
            timestamp: new Date().toISOString(),
          },
        );
        return { dataHandles: [handle] };
      },
    },

    create: {
      description: "Create a new note",
      arguments: z.object({
        name: z.string().describe(
          "Path for new note (e.g. 'folder/note.md' or 'note')",
        ),
        content: z.string().optional().describe("Note content"),
        template: z.string().optional().describe("Template name to use"),
        overwrite: z.boolean().optional().describe("Overwrite if file exists"),
      }),
      execute: async (args, context) => {
        const nameKey = args.name.includes("/") ? "path" : "name";
        const params: Record<string, string> = { [nameKey]: args.name };
        if (args.content) params.content = args.content;
        if (args.template) params.template = args.template;
        const bareFlags = args.overwrite ? ["overwrite"] : undefined;
        await runObsidian(
          "create",
          params,
          context.globalArgs.vault,
          bareFlags,
        );
        const handle = await context.writeResource(
          "operationResult",
          "create",
          {
            operation: "create",
            file: args.name,
            success: true,
            timestamp: new Date().toISOString(),
          },
        );
        return { dataHandles: [handle] };
      },
    },

    append: {
      description: "Append content to end of a note",
      arguments: z.object({
        file: z.string().describe("Path to note"),
        content: z.string().describe("Content to append"),
        inline: z.boolean().optional().describe("Append without newline"),
      }),
      execute: async (args, context) => {
        const bareFlags = args.inline ? ["inline"] : undefined;
        await runObsidian(
          "append",
          { ...fileParam(args.file), content: args.content },
          context.globalArgs.vault,
          bareFlags,
        );
        const handle = await context.writeResource(
          "operationResult",
          "append",
          {
            operation: "append",
            file: args.file,
            success: true,
            timestamp: new Date().toISOString(),
          },
        );
        return { dataHandles: [handle] };
      },
    },

    prepend: {
      description: "Prepend content after frontmatter",
      arguments: z.object({
        file: z.string().describe("Path to note"),
        content: z.string().describe("Content to prepend"),
        inline: z.boolean().optional().describe("Prepend without newline"),
      }),
      execute: async (args, context) => {
        const bareFlags = args.inline ? ["inline"] : undefined;
        await runObsidian(
          "prepend",
          { ...fileParam(args.file), content: args.content },
          context.globalArgs.vault,
          bareFlags,
        );
        const handle = await context.writeResource(
          "operationResult",
          "prepend",
          {
            operation: "prepend",
            file: args.file,
            success: true,
            timestamp: new Date().toISOString(),
          },
        );
        return { dataHandles: [handle] };
      },
    },

    delete: {
      description: "Delete a note (moves to trash by default)",
      arguments: z.object({
        file: z.string().describe("Path to note"),
        permanent: z.boolean().optional().describe(
          "Permanently delete instead of trash",
        ),
      }),
      execute: async (args, context) => {
        const bareFlags = args.permanent ? ["permanent"] : undefined;
        await runObsidian(
          "delete",
          fileParam(args.file),
          context.globalArgs.vault,
          bareFlags,
        );
        const handle = await context.writeResource(
          "operationResult",
          "delete",
          {
            operation: args.permanent ? "delete-permanent" : "delete",
            file: args.file,
            success: true,
            timestamp: new Date().toISOString(),
          },
        );
        return { dataHandles: [handle] };
      },
    },

    move: {
      description: "Move or rename a note (automatically rewrites wikilinks)",
      arguments: z.object({
        file: z.string().describe("Current path"),
        to: z.string().describe("Destination folder or path"),
      }),
      execute: async (args, context) => {
        await runObsidian(
          "move",
          { ...fileParam(args.file), to: args.to },
          context.globalArgs.vault,
        );
        const handle = await context.writeResource("operationResult", "move", {
          operation: "move",
          file: `${args.file} -> ${args.to}`,
          success: true,
          timestamp: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    // --- Search ---

    search: {
      description: "Full-text search with matching line context",
      arguments: z.object({
        query: z.string().describe("Search query"),
        path: z.string().optional().describe("Limit to folder"),
        limit: z.number().optional().describe("Max files to return"),
      }),
      execute: async (args, context) => {
        // search:context returns [{file, matches: [{line, text}]}]
        const params: Record<string, string> = { query: args.query };
        if (args.path) params.path = args.path;
        if (args.limit) params.limit = String(args.limit);
        const data = await runObsidianJson(
          "search:context",
          params,
          context.globalArgs.vault,
        );
        const results = Array.isArray(data) ? data : [];
        const handle = await context.writeResource("searchResults", "main", {
          query: args.query,
          results: results.map((r) => ({
            file: r.file || "",
            matches: Array.isArray(r.matches) ? r.matches : [],
          })),
          count: results.length,
          timestamp: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    // --- Tags ---

    tags: {
      description: "List all tags in the vault",
      arguments: z.object({
        counts: z.boolean().optional().describe("Include occurrence counts"),
      }),
      execute: async (args, context) => {
        // tags format=json returns [{tag: "#name"}, ...] or with counts [{tag, count}]
        const bareFlags = args.counts ? ["counts"] : undefined;
        const data = await runObsidianJson(
          "tags",
          {},
          context.globalArgs.vault,
          bareFlags,
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
          timestamp: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    tag: {
      description: "List files with a specific tag",
      arguments: z.object({
        name: z.string().describe("Tag name (e.g. '#swamp' or 'swamp')"),
      }),
      execute: async (args, context) => {
        // `tag` command uses name= param, returns plain text lines (no JSON)
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
            timestamp: new Date().toISOString(),
          },
        );
        return { dataHandles: [handle] };
      },
    },

    // --- Links ---

    links: {
      description: "Show outgoing links from a note",
      arguments: z.object({
        file: z.string().describe("Path to note"),
      }),
      execute: async (args, context) => {
        // links does not reliably support format=json; returns text lines or "No links found."
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
          timestamp: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    backlinks: {
      description: "Show files linking to a note",
      arguments: z.object({
        file: z.string().describe("Path to note"),
      }),
      execute: async (args, context) => {
        // backlinks supports format=json but falls back to text when empty
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
          // Fallback: parse as text
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
          timestamp: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    orphans: {
      description: "List notes with no incoming links",
      arguments: z.object({}),
      execute: async (_args, context) => {
        // orphans does not support format=json — returns plain text lines
        const stdout = await runObsidian(
          "orphans",
          {},
          context.globalArgs.vault,
        );
        const files = parseLines(stdout);
        const handle = await context.writeResource("notes", "orphans", {
          files,
          count: files.length,
          timestamp: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    unresolved: {
      description: "List unresolved/broken links in vault",
      arguments: z.object({
        verbose: z.boolean().optional().describe("Include source files"),
      }),
      execute: async (args, context) => {
        // unresolved format=json returns [{link: "..."}, ...] or with counts [{link, count}]
        const bareFlags = args.verbose ? ["verbose"] : undefined;
        const data = await runObsidianJson(
          "unresolved",
          {},
          context.globalArgs.vault,
          bareFlags,
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
          timestamp: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    // --- Daily Notes ---

    daily: {
      description: "Open or create today's daily note",
      arguments: z.object({}),
      execute: async (_args, context) => {
        await runObsidian("daily", {}, context.globalArgs.vault);
        const handle = await context.writeResource("operationResult", "daily", {
          operation: "daily",
          success: true,
          message: "Daily note opened/created",
          timestamp: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    dailyRead: {
      description: "Read today's daily note content",
      arguments: z.object({}),
      execute: async (_args, context) => {
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
          timestamp: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    dailyAppend: {
      description: "Append content to today's daily note",
      arguments: z.object({
        content: z.string().describe("Content to append"),
        inline: z.boolean().optional().describe("Append without newline"),
      }),
      execute: async (args, context) => {
        const bareFlags = args.inline ? ["inline"] : undefined;
        await runObsidian(
          "daily:append",
          { content: args.content },
          context.globalArgs.vault,
          bareFlags,
        );
        const handle = await context.writeResource(
          "operationResult",
          "dailyAppend",
          {
            operation: "daily:append",
            success: true,
            timestamp: new Date().toISOString(),
          },
        );
        return { dataHandles: [handle] };
      },
    },

    dailyPrepend: {
      description: "Prepend content to today's daily note",
      arguments: z.object({
        content: z.string().describe("Content to prepend"),
        inline: z.boolean().optional().describe("Prepend without newline"),
      }),
      execute: async (args, context) => {
        const bareFlags = args.inline ? ["inline"] : undefined;
        await runObsidian(
          "daily:prepend",
          { content: args.content },
          context.globalArgs.vault,
          bareFlags,
        );
        const handle = await context.writeResource(
          "operationResult",
          "dailyPrepend",
          {
            operation: "daily:prepend",
            success: true,
            timestamp: new Date().toISOString(),
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
      }),
      execute: async (args, context) => {
        // properties format=json returns {key: value, ...}
        const data = await runObsidianJson(
          "properties",
          fileParam(args.file),
          context.globalArgs.vault,
        );
        const properties = data || {};
        const handle = await context.writeResource(
          "properties",
          args.file.replace(/[/\\]/g, "_"),
          {
            file: args.file,
            properties,
            timestamp: new Date().toISOString(),
          },
        );
        return { dataHandles: [handle] };
      },
    },

    propertySet: {
      description: "Set a frontmatter property on a note",
      arguments: z.object({
        file: z.string().describe("Path to note"),
        name: z.string().describe("Property name"),
        value: z.string().describe(
          'Property value (use JSON array for list types, e.g. \'["a","b"]\')',
        ),
        type: z.enum(["text", "list", "number", "checkbox", "date", "datetime"])
          .optional()
          .describe("Property type hint"),
      }),
      execute: async (args, context) => {
        const params: Record<string, string> = {
          ...fileParam(args.file),
          name: args.name,
          value: args.value,
        };
        if (args.type) params.type = args.type;
        await runObsidian("property:set", params, context.globalArgs.vault);
        const handle = await context.writeResource(
          "operationResult",
          "propertySet",
          {
            operation: "property:set",
            file: args.file,
            success: true,
            message: `Set ${args.name}=${args.value}`,
            timestamp: new Date().toISOString(),
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
      }),
      execute: async (args, context) => {
        await runObsidian("property:remove", {
          ...fileParam(args.file),
          name: args.name,
        }, context.globalArgs.vault);
        const handle = await context.writeResource(
          "operationResult",
          "propertyRemove",
          {
            operation: "property:remove",
            file: args.file,
            success: true,
            message: `Removed ${args.name}`,
            timestamp: new Date().toISOString(),
          },
        );
        return { dataHandles: [handle] };
      },
    },
  },
};
